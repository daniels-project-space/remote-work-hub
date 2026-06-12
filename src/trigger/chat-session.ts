/**
 * `chat-dispatcher` — the cloud replacement for the 21st.dev hub chat.
 *
 * A 1-minute declarative schedule (a PAT cannot trigger on demand, so we poll).
 * Each run drains the Convex pending-message queue. For each user message it
 * mounts the right files, runs Claude Code (Opus) HEADLESS on the subscription
 * token, streams the reply into Convex, then commits + pushes.
 *
 * Three workspace modes:
 *  - `hq` META workspace: every repo cloned side-by-side; the agent cd's into
 *    whichever it needs; each changed repo is pushed.
 *  - single real "owner/name" repo: cloned at the cwd; pushed if changed.
 *  - no repo: general chat in a scratch dir (always exists).
 * Claude ALWAYS runs in a directory that exists, and an empty/failed turn
 * finalizes with a visible error — never a blank bubble.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { schedules } from "@trigger.dev/sdk";

const require = createRequire(import.meta.url);
const CONVEX = "https://groovy-cardinal-733.convex.cloud";
const SCRATCH = "/tmp/ws/_scratch";
const RUN_BUDGET_MS = 55_000;
const IDLE_EXITS = 3;
const POLL_MS = 1_500;

// hq meta workspace: EVERY repo in the org, fetched live at runtime so newly
// added projects appear automatically (no redeploy). Falls back to this static
// list only if the GitHub API call fails.
const META_SLUG = "hq";
const ORG = "daniels-project-space";
const META_REPOS_FALLBACK: Record<string, string> = {
  "project-hub": "daniels-project-space/project-hub",
  "remote-work-hub": "daniels-project-space/remote-work-hub",
  "music-house": "daniels-project-space/music-house",
  "rental-manager-v2": "daniels-project-space/rental-manager-v2",
  "youtube-studio-ai": "daniels-project-space/youtube-studio-ai",
  "db-cinema-v2": "daniels-project-space/db-cinema-v2",
  "finance-engine-v2": "daniels-project-space/finance-engine-v2",
};

/** Live list of every active (non-archived, non-fork) repo in the org. */
async function listOrgRepos(token: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(
        `https://api.github.com/orgs/${ORG}/repos?per_page=100&page=${page}&type=all&sort=full_name`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "remote-work-hub-dispatcher",
          },
        },
      );
      if (!res.ok) break;
      const batch = (await res.json()) as Array<{
        name: string;
        full_name: string;
        archived?: boolean;
        fork?: boolean;
      }>;
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const r of batch) {
        if (!r.archived && !r.fork) out[r.name] = r.full_name;
      }
      if (batch.length < 100) break;
    }
  } catch {
    /* fall through to fallback */
  }
  return Object.keys(out).length ? out : META_REPOS_FALLBACK;
}

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

async function cloneOrRefresh(
  dir: string,
  repo: string,
  token: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (existsSync(join(dir, ".git"))) {
    await sh("git", ["-C", dir, "fetch", "--depth", "1", "origin"], { env });
    await sh("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], { env });
    return true;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const clone = await sh("git", ["clone", "--depth", "1", remoteUrl(repo, token), dir], { env });
  if (clone.code !== 0 || !existsSync(join(dir, ".git"))) return false;
  await sh("git", ["-C", dir, "config", "user.name", "Remote Work Hub Agent"], { env });
  await sh("git", ["-C", dir, "config", "user.email", "agent@remoteworkhq.local"], { env });
  return true;
}

/** Single repo. Returns the dir or null on clone failure. */
async function prepareRepo(slug: string, repo: string, token: string, env: NodeJS.ProcessEnv) {
  const dir = `/tmp/ws/${slug.replace(/[^a-z0-9_-]/gi, "_")}`;
  return (await cloneOrRefresh(dir, repo, token, env)) ? dir : null;
}

/** hq meta workspace: clone EVERY active org repo side-by-side (in parallel). */
async function prepareMetaWorkspace(token: string, env: NodeJS.ProcessEnv) {
  const base = "/tmp/ws/hq";
  mkdirSync(base, { recursive: true });
  const map = await listOrgRepos(token);
  const entries = Object.entries(map);
  const repos = await Promise.all(
    entries.map(async ([sub, repo]) => {
      const dir = join(base, sub);
      const ok = await cloneOrRefresh(dir, repo, token, env);
      return { sub, dir, repo, ok };
    }),
  );
  return { base, names: entries.map(([sub]) => sub), repos: repos.filter((r) => r.ok) };
}

/**
 * Commit + push a cloned repo. Handles BOTH cases: the agent left uncommitted
 * changes (we commit them), or the agent already committed during its turn
 * (clean tree but a commit ahead of origin — must still be pushed). Returns a
 * short status, or null if there was genuinely nothing to push.
 */
async function commitAndPush(dir: string, repo: string, token: string, env: NodeJS.ProcessEnv) {
  await sh("git", ["-C", dir, "add", "-A"], { env });
  const status = await sh("git", ["-C", dir, "status", "--porcelain"], { env });
  if (status.stdout.trim()) {
    await sh("git", ["-C", dir, "commit", "-m", "chat: changes from hub conversation"], { env });
  }
  // Always attempt the push — a no-op if nothing is ahead. This is what catches
  // the agent's own commit (clean tree, commit ahead of origin).
  let push = await sh("git", ["-C", dir, "push", remoteUrl(repo, token), "HEAD"], { env });
  const out = (push.stdout + push.stderr).toLowerCase();
  if (/shallow update not allowed/.test(out)) {
    await sh("git", ["-C", dir, "fetch", "--unshallow"], { env });
    push = await sh("git", ["-C", dir, "push", remoteUrl(repo, token), "HEAD"], { env });
  }
  const out2 = (push.stdout + push.stderr).toLowerCase();
  if (/everything up-to-date/.test(out2)) return null;
  return push.code === 0 ? `pushed ${repo}` : `push failed ${repo}: ${push.stderr.slice(0, 140)}`;
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
    "When you change code, commit it (git -C <dir> commit -am '...') but do NOT push — the hub pushes for you.";
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

    while (Date.now() - started < RUN_BUDGET_MS) {
      const claim = (await convexMutation("chat:claimNext", {})) as ClaimResult;
      if (!claim) {
        idle += 1;
        if (processed === 0 && idle >= IDLE_EXITS) break;
        await sleep(POLL_MS);
        continue;
      }
      idle = 0;

      try {
        let cwd = SCRATCH;
        let repoContext: string;
        let singleRepoDir: string | null = null;
        let metaRepos: { dir: string; repo: string }[] | null = null;

        if (claim.projectSlug === META_SLUG && token) {
          const meta = await prepareMetaWorkspace(token, env);
          cwd = meta.base;
          metaRepos = meta.repos.map((r) => ({ dir: r.dir, repo: r.repo }));
          const subs = meta.repos.map((r) => r.sub);
          repoContext =
            "This is the HQ meta workspace at the cwd. EVERY active project in the org is cloned " +
            "here as a subdirectory (this list is live — new projects appear automatically): " +
            subs.join(", ") +
            ". cd into whichever you need, read/edit files there, and commit inside that subdir " +
            "(git -C <subdir> commit -am '...'). The hub pushes each repo you changed. " +
            "This includes the hub itself (remote-work-hub) and the dashboard (project-hub).";
        } else if (isRealRepo(claim.repo) && token) {
          singleRepoDir = await prepareRepo(claim.projectSlug, claim.repo, token, env);
          if (singleRepoDir) {
            cwd = singleRepoDir;
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

        // Push whatever changed.
        let pushResult = "no repo";
        if (metaRepos) {
          const pushes: string[] = [];
          for (const r of metaRepos) {
            const res = await commitAndPush(r.dir, r.repo, token, env).catch(() => null);
            if (res) pushes.push(res);
          }
          pushResult = pushes.length ? pushes.join("; ") : "nothing to push";
        } else if (singleRepoDir) {
          pushResult = (await commitAndPush(singleRepoDir, claim.repo, token, env).catch(() => null)) ?? "nothing to push";
        }

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
