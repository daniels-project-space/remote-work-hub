/**
 * `claude-spike` — proves Claude Code runs HOSTLESS in the Trigger image on the
 * subscription token (CLAUDE_CODE_OAUTH_TOKEN, injected as a Trigger env var),
 * with zero VPS/local involvement, and reports the result back through the hub's
 * Convex deployment.
 *
 * Self-triggering via a 1-minute declarative schedule so it needs no secret key
 * to fire (a PAT cannot trigger tasks). It posts to Convex `spike:record`; read
 * the outcome with `spike:latest`. Temporary scaffold — deleted once the real
 * chat task lands.
 *
 * The `claude` bin is NOT on PATH (additionalPackages installs into the image
 * node_modules, and the task's cwd is the bundle dir). We resolve the package
 * via createRequire and exec node_modules/.bin/claude by absolute path.
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { schedules } from "@trigger.dev/sdk";

const require = createRequire(import.meta.url);
const CONVEX_HTTP = "https://groovy-cardinal-733.convex.cloud";

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, cwd });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) =>
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${e.message}` }),
    );
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Resolve the absolute path to the claude binary inside the image node_modules. */
function resolveClaudeBin(): { binPath: string | null; tried: string[]; error?: string } {
  const tried: string[] = [];
  try {
    const pkgJson = require.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson); // .../node_modules/@anthropic-ai/claude-code
    const nodeModules = dirname(dirname(pkgDir)); // .../node_modules
    const candidates = [join(nodeModules, ".bin", "claude")];
    // package-local bin entry (string or { claude })
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
      if (rel) candidates.push(join(pkgDir, rel));
    } catch {
      /* ignore */
    }
    for (const c of candidates) {
      tried.push(c);
      if (existsSync(c)) return { binPath: c, tried };
    }
    return { binPath: null, tried };
  } catch (e) {
    return { binPath: null, tried, error: e instanceof Error ? e.message : String(e) };
  }
}

async function report(ok: boolean, detail: string): Promise<void> {
  try {
    await fetch(`${CONVEX_HTTP}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "spike:record",
        args: { at: Date.now(), ok, detail: detail.slice(0, 4000) },
        format: "json",
      }),
    });
  } catch {
    /* best-effort */
  }
}

export async function runClaudeSpike() {
  const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const HOME = "/tmp/claude-home";
  mkdirSync(HOME, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME, ANTHROPIC_API_KEY: "" };

  const { binPath, tried, error } = resolveClaudeBin();
  if (!binPath) {
    const detail = JSON.stringify({ hasToken, binResolveError: error ?? "not found", tried });
    await report(false, detail);
    return { ok: false, detail };
  }

  const res = await run(
    binPath,
    [
      "-p",
      "Reply with exactly: ok, then your model id. Nothing else.",
      "--model",
      "claude-sonnet-4-6",
      "--dangerously-skip-permissions",
    ],
    env,
    HOME,
  );

  const out = (res.stdout || res.stderr || "").trim();
  const ok = res.code === 0 && !/invalid api key/i.test(out) && out.length > 0;
  const detail = JSON.stringify({
    hasToken,
    binPath,
    exitCode: res.code,
    stdout: res.stdout.slice(0, 1500),
    stderr: res.stderr.slice(0, 800),
  });
  await report(ok, detail);
  return { ok, detail };
}

export const claudeSpikeTask = schedules.task({
  id: "claude-spike",
  cron: "0 0 1 1 *", // PARKED (Jan 1 only) — spike proven; real task lives in chat-session.ts
  run: runClaudeSpike,
});
