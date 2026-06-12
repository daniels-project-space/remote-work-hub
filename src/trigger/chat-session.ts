/**
 * `chat-dispatcher` — the cloud replacement for the 21st.dev hub chat.
 *
 * A 1-minute declarative schedule (a PAT cannot trigger on demand, so we poll).
 * Each run drains the Convex pending-message queue: for every user message it
 * clones the project's repo, runs Claude Code (Opus) HEADLESS on the
 * subscription token, streams the reply back into Convex, then commits + pushes.
 *
 * Robustness rules learned the hard way:
 *  - Only clone when repo is a real "owner/name" (the `hq` meta workspace's
 *    "repo" is just the org label — not cloneable). Otherwise run general chat.
 *  - Claude ALWAYS runs in a directory that exists; a failed clone never leaves
 *    a missing cwd (which silently produced empty 3s replies).
 *  - An empty/failed turn finalizes with a visible error, never a blank bubble.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { schedules } from "@trigger.dev/sdk";

const require = createRequire(import.meta.url);
const CONVEX = "https://groovy-cardinal-733.convex.cloud";
const SCRATCH = "/tmp/ws/_scratch";
const RUN_BUDGET_MS = 50_000;
const IDLE_EXITS = 3;

type ClaimResult = {
  projectSlug: string;
  repo: string;
  userText: string;
  assistantId: string;
  claudeSessionId: string | null;
  history: { role: string; text: string }[];
} | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRealRepo = (repo: string) => /^[^/\s]+\/[^/\s]+$/.test(repo);

async function convexMutation(path: string, args: Record<string, unknown>) {
  const res = await fetch(`${CONVEX}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const json = (await res.json()) as { status?: string; value?: unknown };
  return json.value;
}

function resolveClaudeBin(): string | null {
  try {
    const pkgJson = require.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson);
    const nodeModules = dirname(dirname(pkgDir));
    const candidates = [join(nodeModules, ".bin", "claude")];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
      if (rel) candidates.push(join(pkgDir, rel));
    } catch {
      /* ignore */
    }
    return candidates.find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + `\n${e.message}` }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const remoteUrl = (repo: string, token: string) =>
  `https://x-access-token:${token}@github.com/${repo}.git`;

/** Clone (or refresh) a real repo. Returns the dir, or null if the clone failed. */
async function prepareRepo(
  slug: string,
  repo: string,
  token: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const dir = `/tmp/ws/${slug.replace(/[^a-z0-9_-]/gi, "_")}`;
  if (existsSync(join(dir, ".git"))) {
    await sh("git", ["-C", dir, "fetch", "--depth", "1", "origin"], { env });
    await sh("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], { env });
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const clone = await sh("git", ["clone", "--depth", "1", remoteUrl(repo, token), dir], { env });
  if (clone.code !== 0 || !existsSync(join(dir, ".git"))) return null;
  await sh("git", ["-C", dir, "config", "user.name", "Remote Work Hub Agent"], { env });
  await sh("git", ["-C", dir, "config", "user.email", "agent@remoteworkhq.local"], { env });
  return dir;
}

async function runTurn(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  assistantId: string,
  userText: string,
  history: { role: string; text: string }[],
  repoContext: string,
): Promise<{ finalText: string; sessionId: string | null; code: number | null; stderr: string }> {
  const preamble =
    "You are the Remote Work Hub agent, reachable from the user's phone. " +
    repoContext +
    " Keep replies concise and grounded in what you actually did. " +
    "When you change code, commit it (git -C . commit -am '...') but do NOT push — the hub pushes for you.";
  const convo =
    history.length > 0
      ? "Recent conversation:\n" +
        history.map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`).join("\n") +
        "\n\n"
      : "";
  const prompt = `${convo}User: ${userText}`;

  const args = [
    "-p",
    prompt,
    "--append-system-prompt",
    preamble,
    "--model",
    "opus",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  return await new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let finalText = "";
    let sessionId: string | null = null;
    let pending = "";
    let stderr = "";

    const flush = async () => {
      if (!pending) return;
      const chunk = pending;
      pending = "";
      await convexMutation("chat:appendChunk", { messageId: assistantId, chunk }).catch(() => {});
    };
    const flushTimer = setInterval(() => void flush(), 600);

    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.session_id && !sessionId) sessionId = ev.session_id;
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const t = ev.event.delta?.text;
          if (typeof t === "string") pending += t;
        }
        if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
      }
    });

    p.on("close", async (code) => {
      clearInterval(flushTimer);
      await flush();
      resolve({ finalText, sessionId, code, stderr: stderr.slice(-400) });
    });
    p.on("error", async (e) => {
      clearInterval(flushTimer);
      await flush();
      resolve({ finalText, sessionId, code: -1, stderr: (stderr + "\n" + e.message).slice(-400) });
    });
  });
}

export const chatDispatcher = schedules.task({
  id: "chat-dispatcher",
  cron: "* * * * *",
  maxDuration: 3300,
  run: async () => {
    const bin = resolveClaudeBin();
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: "/tmp/claude-home",
      ANTHROPIC_API_KEY: "",
    };
    mkdirSync("/tmp/claude-home", { recursive: true });
    mkdirSync(SCRATCH, { recursive: true });

    if (!bin) return { processed: 0, error: "claude binary not found" };

    const started = Date.now();
    let processed = 0;
    let idle = 0;

    while (Date.now() - started < RUN_BUDGET_MS && idle < IDLE_EXITS) {
      const claim = (await convexMutation("chat:claimNext", {})) as ClaimResult;
      if (!claim) {
        idle += 1;
        await sleep(2000);
        continue;
      }
      idle = 0;

      try {
        // Decide working dir + how to brief the agent about the repo.
        let cwd = SCRATCH;
        let repoDir: string | null = null;
        let repoContext: string;
        if (isRealRepo(claim.repo) && token) {
          repoDir = await prepareRepo(claim.projectSlug, claim.repo, token, env);
          if (repoDir) {
            cwd = repoDir;
            repoContext = `Your working directory IS the git repo ${claim.repo} (already cloned).`;
          } else {
            repoContext = `NOTE: repo ${claim.repo} could not be cloned this turn — answer from knowledge; you cannot edit files.`;
          }
        } else {
          repoContext =
            "No single repo is mounted this turn (general workspace) — answer the user; you cannot edit files.";
        }

        const turn = await runTurn(
          bin,
          cwd,
          env,
          claim.assistantId,
          claim.userText,
          claim.history,
          repoContext,
        );

        // commit + push only when a real repo cloned cleanly
        let pushResult = repoDir ? "nothing to push" : "no repo";
        if (repoDir) {
          await sh("git", ["-C", repoDir, "add", "-A"], { env });
          const status = await sh("git", ["-C", repoDir, "status", "--porcelain"], { env });
          if (status.stdout.trim()) {
            await sh("git", ["-C", repoDir, "commit", "-m", "chat: changes from hub conversation"], { env });
            const push = await sh("git", ["-C", repoDir, "push", remoteUrl(claim.repo, token), "HEAD"], { env });
            pushResult = push.code === 0 ? "pushed" : `push failed: ${push.stderr.slice(0, 200)}`;
          }
        }

        // Never leave a blank bubble: surface failures.
        const finalText =
          turn.finalText.trim() ||
          (turn.code === 0
            ? "(the agent finished without producing any text)"
            : `⚠️ the agent run failed (exit ${turn.code}). ${turn.stderr || ""}`.trim());

        await convexMutation("chat:finalize", {
          messageId: claim.assistantId,
          projectSlug: claim.projectSlug,
          status: turn.finalText.trim() ? "done" : "error",
          claudeSessionId: turn.sessionId ?? undefined,
          pushResult,
          finalText,
        });
        processed += 1;
      } catch (e) {
        await convexMutation("chat:finalize", {
          messageId: claim.assistantId,
          projectSlug: claim.projectSlug,
          status: "error",
          finalText: `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`,
        }).catch(() => {});
      }
    }

    return { processed };
  },
});
