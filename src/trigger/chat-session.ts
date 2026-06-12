/**
 * `chat-dispatcher` — the cloud replacement for the 21st.dev hub chat.
 *
 * A 1-minute declarative schedule (a PAT cannot trigger on demand, so we poll).
 * Each run drains the Convex pending-message queue: for every user message it
 * clones the project's repo, runs Claude Code (Opus) HEADLESS on the
 * subscription token, streams the reply back into Convex, then commits + pushes.
 *
 * Cold-start latency is <=60s; once a conversation is active the in-run tight
 * poll picks up follow-ups in ~2s. Drop a prod TRIGGER secret key in later to
 * make `sendMessage` trigger this instantly.
 *
 * Auth + binary resolution are exactly as proven by claude-spike.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { schedules } from "@trigger.dev/sdk";

const require = createRequire(import.meta.url);
const CONVEX = "https://groovy-cardinal-733.convex.cloud";
const RUN_BUDGET_MS = 50_000; // stop claiming new work after this; never cut a turn off
const IDLE_EXITS = 3; // empty polls (~2s each) before giving up this run

type ClaimResult = {
  projectSlug: string;
  repo: string;
  userText: string;
  assistantId: string;
  claudeSessionId: string | null;
  history: { role: string; text: string }[];
} | null;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function remoteUrl(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/** Clone (or refresh) the repo into a per-project workdir. */
async function prepareRepo(
  slug: string,
  repo: string,
  token: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const dir = `/tmp/ws/${slug}`;
  if (existsSync(join(dir, ".git"))) {
    await sh("git", ["-C", dir, "fetch", "--depth", "1", "origin"], { env });
    await sh("git", ["-C", dir, "reset", "--hard", "origin/HEAD"], { env });
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  await sh("git", ["clone", "--depth", "1", remoteUrl(repo, token), dir], { env });
  await sh("git", ["-C", dir, "config", "user.name", "Remote Work Hub Agent"], { env });
  await sh("git", ["-C", dir, "config", "user.email", "agent@remoteworkhq.local"], { env });
  return dir;
}

/** Run one Claude turn, streaming text into Convex. Returns final text + session id. */
async function runTurn(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  assistantId: string,
  userText: string,
  history: { role: string; text: string }[],
): Promise<{ finalText: string; sessionId: string | null }> {
  const preamble =
    "You are the Remote Work Hub agent. Your working directory IS the project's git repo. " +
    "Make code changes directly with your tools and commit them with clear messages " +
    "(git -C . commit -am '...'). Do NOT run 'git push' — the hub pushes for you after you finish. " +
    "Keep replies concise and grounded in what you actually did.";
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

    const flush = async () => {
      if (!pending) return;
      const chunk = pending;
      pending = "";
      await convexMutation("chat:appendChunk", { messageId: assistantId, chunk }).catch(() => {});
    };
    const flushTimer = setInterval(() => void flush(), 600);

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
        // token-level deltas (live typing)
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const t = ev.event.delta?.text;
          if (typeof t === "string") pending += t;
        }
        // authoritative final text
        if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
      }
    });

    p.on("close", async () => {
      clearInterval(flushTimer);
      await flush();
      resolve({ finalText, sessionId });
    });
    p.on("error", async () => {
      clearInterval(flushTimer);
      await flush();
      resolve({ finalText, sessionId });
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
        const cwd =
          claim.repo && token
            ? await prepareRepo(claim.projectSlug, claim.repo, token, env)
            : "/tmp/claude-home";

        const { finalText, sessionId } = await runTurn(
          bin,
          cwd,
          env,
          claim.assistantId,
          claim.userText,
          claim.history,
        );

        // commit + push anything the agent changed
        let pushResult = "no repo";
        if (claim.repo && token && cwd !== "/tmp/claude-home") {
          await sh("git", ["-C", cwd, "add", "-A"], { env });
          const status = await sh("git", ["-C", cwd, "status", "--porcelain"], { env });
          if (status.stdout.trim()) {
            await sh(
              "git",
              ["-C", cwd, "commit", "-m", "chat: changes from hub conversation"],
              { env },
            );
          }
          const ahead = await sh(
            "git",
            ["-C", cwd, "rev-list", "--count", "@{u}..HEAD"],
            { env },
          );
          if ((ahead.stdout.trim() || "0") !== "0") {
            const push = await sh("git", ["-C", cwd, "push", remoteUrl(claim.repo, token), "HEAD"], {
              env,
            });
            pushResult = push.code === 0 ? "pushed" : `push failed: ${push.stderr.slice(0, 200)}`;
          } else {
            pushResult = "nothing to push";
          }
        }

        await convexMutation("chat:finalize", {
          messageId: claim.assistantId,
          projectSlug: claim.projectSlug,
          status: "done",
          claudeSessionId: sessionId ?? undefined,
          pushResult,
          finalText: finalText || undefined,
        });
        processed += 1;
      } catch (e) {
        await convexMutation("chat:finalize", {
          messageId: claim.assistantId,
          projectSlug: claim.projectSlug,
          status: "error",
          finalText: `Error: ${e instanceof Error ? e.message : String(e)}`,
        }).catch(() => {});
      }
    }

    return { processed };
  },
});
