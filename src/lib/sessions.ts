import "server-only";
import { AgentClient } from "@21st-sdk/node";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  getRepoForSlug,
  getServicesForSlug,
  META_REPOS,
  META_SLUG,
} from "@/lib/projects";

const PROJECT_PATH = "/home/user/workspace/project";
const READY_PATH = `${PROJECT_PATH}/.hub-ready`;
const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;

const NETWORK_ALLOW = [
  "github.com",
  "*.github.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
];
const NETWORK_DENY = ["0.0.0.0/0"];

export type Session = {
  id: Id<"sessions">;
  slug: string;
  sandboxId: string;
  threadId: string | null;
  repo: string;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  lastResponseAt: string | null;
};

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function agentClient(): AgentClient {
  return new AgentClient({ apiKey: need("API_KEY_21ST") });
}

let convexClientInstance: ConvexHttpClient | null = null;
function convex(): ConvexHttpClient {
  if (!convexClientInstance) {
    convexClientInstance = new ConvexHttpClient(need("NEXT_PUBLIC_CONVEX_URL"));
  }
  return convexClientInstance;
}

function buildRemoteUrl(repo: string, ghToken: string): string {
  return `https://x-access-token:${ghToken}@github.com/${repo}.git`;
}

const VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";

// Bash one-liner that runs inside the sandbox: pulls every key for each
// requested service from the project-hub Convex secrets vault and appends
// KEY=VALUE lines to .env.local in the cloned project. Idempotent — replaces
// any existing line with the same KEY.
function buildVaultPullCommand(services: string[]): string {
  const env = JSON.stringify(VAULT_URL);
  const svcList = JSON.stringify(services);
  return [
    `python3 - <<'PYEND'`,
    `import urllib.request, json, os`,
    `VAULT = ${env}`,
    `services = ${svcList}`,
    `lines = []`,
    `for svc in services:`,
    `    body = json.dumps({\"path\":\"secrets:listByService\",\"args\":{\"service\":svc},\"format\":\"json\"}).encode()`,
    `    req = urllib.request.Request(VAULT + \"/api/query\", data=body, headers={\"Content-Type\":\"application/json\"}, method=\"POST\")`,
    `    rows = json.loads(urllib.request.urlopen(req).read()).get(\"value\", []) or []`,
    `    for r in rows:`,
    `        v = (r.get(\"value\") or \"\").replace(\"\\n\", \"\\\\n\")`,
    `        lines.append(f\"{r['keyName']}={v}\")`,
    `p = \"${PROJECT_PATH}/.env.local\"`,
    `existing = open(p).read() if os.path.exists(p) else \"\"`,
    `new_keys = {l.split(\"=\",1)[0] for l in lines}`,
    `keep = [l for l in existing.splitlines() if l and l.split(\"=\",1)[0] not in new_keys]`,
    `open(p,\"w\").write(\"\n\".join(keep + lines) + \"\n\")`,
    `print(f\"vault: wrote {len(lines)} keys from {len(services)} services\")`,
    `PYEND`,
  ].join("\n");
}

function buildSetup(remoteUrl: string, priorLog: string | null, services: string[]): string[] {
  const steps = [
    `mkdir -p /home/user/workspace`,
    `git clone --depth 1 ${remoteUrl} ${PROJECT_PATH}`,
    `chmod -R a+rw ${PROJECT_PATH}`,
    `git -C ${PROJECT_PATH} config user.name "Remote Work Hub Agent"`,
    `git -C ${PROJECT_PATH} config user.email "agent@remoteworkhq.local"`,
    `git -C ${PROJECT_PATH} remote set-url origin ${remoteUrl}`,
    `git config --system --add safe.directory '*' || git config --global --add safe.directory '*'`,
  ];
  if (services.length > 0) steps.push(buildVaultPullCommand(services));
  if (priorLog) {
    const b64 = Buffer.from(priorLog, "utf8").toString("base64");
    steps.push(`mkdir -p /home/user/.hub`);
    steps.push(`echo ${b64} | base64 -d > /home/user/.hub/context.md`);
  }
  steps.push(`touch ${READY_PATH}`);
  return steps;
}

// Map dropped at the workspace root so the agent knows the multi-repo layout
// and the per-repo push rules.
function buildMetaWorkspaceMdCommand(services: string[]): string {
  const repoLines = Object.entries(META_REPOS)
    .map(([dir, repo]) => `- \`${dir}/\` -> github.com/${repo}`)
    .join("\n");
  const content = [
    `# HQ workspace — all repos`,
    ``,
    `Every directory here is an independent git clone with push access:`,
    ``,
    repoLines,
    ``,
    `Rules:`,
    `- Commit inside the repo you changed; each repo pushes to its own origin (main).`,
    `- The hub Push button pushes EVERY repo that has new commits — keep commits clean per repo.`,
    `- Vercel auto-deploys each app from main after push; no manual deploy needed.`,
    `- Platform secrets are in ./.env.local at this workspace root (${services.join(", ")} + GITHUB_TOKEN). It is OUTSIDE every repo — never copy it into a repo.`,
    `- Any other service's keys live in the vault:`,
    `  curl -s -X POST '${VAULT_URL}/api/query' -H 'Content-Type: application/json' -d '{"path":"secrets:listByService","args":{"service":"<name>"},"format":"json"}'`,
  ].join("\n");
  const b64 = Buffer.from(content, "utf8").toString("base64");
  return `echo ${b64} | base64 -d > ${PROJECT_PATH}/WORKSPACE.md`;
}

// Setup for the META_SLUG workspace: every repo in META_REPOS cloned
// side-by-side under PROJECT_PATH (which is a plain directory here, not a git
// repo). Vault env + GitHub token land in PROJECT_PATH/.env.local — outside
// all clones, so it can never be committed.
function buildMetaSetup(
  ghToken: string,
  priorLog: string | null,
  services: string[],
): string[] {
  const steps = [`mkdir -p ${PROJECT_PATH}`];
  for (const [dir, repo] of Object.entries(META_REPOS)) {
    const path = `${PROJECT_PATH}/${dir}`;
    steps.push(`git clone --depth 1 ${buildRemoteUrl(repo, ghToken)} ${path}`);
    steps.push(`git -C ${path} config user.name "Remote Work Hub Agent"`);
    steps.push(`git -C ${path} config user.email "agent@remoteworkhq.local"`);
  }
  steps.push(`chmod -R a+rw ${PROJECT_PATH}`);
  steps.push(
    `git config --system --add safe.directory '*' || git config --global --add safe.directory '*'`,
  );
  steps.push(buildMetaWorkspaceMdCommand(services));
  if (services.length > 0) steps.push(buildVaultPullCommand(services));
  steps.push(
    `printf 'GITHUB_TOKEN=%s\\nGH_TOKEN=%s\\n' '${ghToken}' '${ghToken}' >> ${PROJECT_PATH}/.env.local`,
  );
  if (priorLog) {
    const b64 = Buffer.from(priorLog, "utf8").toString("base64");
    steps.push(`mkdir -p /home/user/.hub`);
    steps.push(`echo ${b64} | base64 -d > /home/user/.hub/context.md`);
  }
  steps.push(`touch ${READY_PATH}`);
  return steps;
}


type ConvexSession = {
  _id: Id<"sessions">;
  _creationTime: number;
  projectSlug: string;
  sandboxId: string;
  threadId?: string | null;
  repo: string;
  status: string;
  transcript?: unknown[];
  startedAt: number;
  lastActiveAt: number;
  lastResponseAt?: number | null;
  endedAt?: number | null;
};

function rowToSession(row: ConvexSession | null | undefined): Session | null {
  if (!row) return null;
  return {
    id: row._id,
    slug: row.projectSlug,
    sandboxId: row.sandboxId,
    threadId: row.threadId ?? null,
    repo: row.repo,
    status: row.status,
    createdAt: new Date(row.startedAt).toISOString(),
    lastActiveAt: new Date(row.lastActiveAt).toISOString(),
    lastResponseAt: row.lastResponseAt
      ? new Date(row.lastResponseAt).toISOString()
      : null,
  };
}

async function isSandboxAlive(sandboxId: string): Promise<boolean> {
  try {
    const detail = await agentClient().sandboxes.get(sandboxId);
    return detail?.status !== "error" && detail?.status !== "dead";
  } catch {
    return false;
  }
}

export async function getActiveSession(slug: string): Promise<Session | null> {
  const row = (await convex().query(api.sessions.getActive, {
    slug,
  })) as ConvexSession | null;
  if (!row) return null;
  if (row.status === "ready") {
    const alive = await isSandboxAlive(row.sandboxId);
    if (!alive) {
      await convex().mutation(api.sessions.markDeadBySandbox, {
        sandboxId: row.sandboxId,
      });
      return null;
    }
  }
  return rowToSession(row);
}

export async function startSpawn(slug: string): Promise<Session> {
  const repo = getRepoForSlug(slug);
  if (!repo) throw new Error(`Unknown project slug: ${slug}`);

  const existing = await getActiveSession(slug);
  if (existing && existing.repo === repo) return existing;

  const ghToken = need("GITHUB_TOKEN");
  const c = agentClient();

  const priorLog = await getLatestLog(slug);
  const setup =
    slug === META_SLUG
      ? buildMetaSetup(ghToken, priorLog, getServicesForSlug(slug))
      : buildSetup(
          buildRemoteUrl(repo, ghToken),
          priorLog,
          getServicesForSlug(slug),
        );
  const sandbox = await c.sandboxes.create({
    agent: "hub-tester",
    timeoutMs: SANDBOX_TIMEOUT_MS,
    networkAllowOut: NETWORK_ALLOW,
    networkDenyOut: NETWORK_DENY,
    setup,
  });

  const thread = await c.threads.create({
    sandboxId: sandbox.id,
    name: slug,
  });

  await convex().mutation(api.sessions.startSpawn, {
    slug,
    sandboxId: sandbox.id,
    threadId: thread.id,
    repo,
  });

  // Re-read so we have the canonical row (incl. _id, lastActiveAt)
  const created = (await convex().query(api.sessions.getActive, {
    slug,
  })) as ConvexSession | null;
  const session = rowToSession(created);
  if (!session) throw new Error("Failed to materialize session row");
  return session;
}

export async function finalizeSpawn(slug: string): Promise<{
  status: "spawning" | "ready" | "missing";
  session: Session | null;
}> {
  const session = await getActiveSession(slug);
  if (!session) return { status: "missing", session: null };
  if (session.status === "ready") return { status: "ready", session };

  const c = agentClient();
  let exit = 1;
  try {
    const r = await c.sandboxes.exec({
      sandboxId: session.sandboxId,
      command: `[ -f ${READY_PATH} ] && echo READY || echo PENDING`,
      timeoutMs: 8_000,
    });
    exit = /READY/.test(r.stdout) ? 0 : 1;
  } catch {
    return { status: "spawning", session };
  }

  if (exit !== 0) return { status: "spawning", session };

  await convex().mutation(api.sessions.markReady, {
    sandboxId: session.sandboxId,
  });
  const updated = (await convex().query(api.sessions.getActive, {
    slug,
  })) as ConvexSession | null;
  return {
    status: "ready",
    session: rowToSession(updated) ?? session,
  };
}

export async function listActiveSessions(): Promise<Session[]> {
  const rows = (await convex().query(
    api.sessions.list,
    {},
  )) as ConvexSession[];
  return rows
    .map((r) => rowToSession(r))
    .filter((s): s is Session => s !== null);
}

// Fast end: flip DB to dead, then fire-and-forget sandbox deletes.
export async function endSession(slug: string): Promise<void> {
  const sandboxIds = (await convex().mutation(api.sessions.endSession, {
    slug,
  })) as string[];
  const c = agentClient();
  for (const id of sandboxIds) {
    void c.sandboxes.delete(id).catch(() => {});
  }
}

export async function recordThreadId(
  slug: string,
  threadId: string,
): Promise<void> {
  await convex().mutation(api.sessions.recordThreadId, { slug, threadId });
}

export type StoredMessage = {
  id: string;
  role: string;
  parts: Array<{ type: string; [k: string]: unknown }>;
};

function normalizeMessages(msgs: unknown[]): StoredMessage[] {
  if (!Array.isArray(msgs)) return [];
  return msgs.map((raw, i) => {
    const m = raw as { id?: string; role?: string; parts?: unknown };
    const id =
      typeof m.id === "string" && m.id.length > 0
        ? m.id
        : `srv-${i}-${typeof m.role === "string" ? m.role : "unknown"}`;
    return {
      ...(m as object),
      id,
      role: typeof m.role === "string" ? m.role : "unknown",
      parts: Array.isArray(m.parts) ? (m.parts as StoredMessage["parts"]) : [],
    };
  });
}

export async function getThreadMessages(slug: string): Promise<StoredMessage[]> {
  const session = await getActiveSession(slug);
  if (session) {
    if (session.threadId) {
      try {
        const thread = await agentClient().threads.get({
          sandboxId: session.sandboxId,
          threadId: session.threadId,
        });
        const raw = thread.messages;
        if (Array.isArray(raw) && raw.length > 0) return normalizeMessages(raw);
      } catch {}
    }
    const own = (await convex().query(api.sessions.getCurrentTranscript, {
      sessionId: session.id,
    })) as unknown[];
    if (own.length > 0) return normalizeMessages(own);
  }
  return getLatestTranscript(slug);
}

export async function getLatestTranscript(
  slug: string,
): Promise<StoredMessage[]> {
  const raw = (await convex().query(api.sessions.getLatestTranscript, {
    slug,
  })) as unknown[];
  return normalizeMessages(raw ?? []);
}

export async function persistTranscript(
  slug: string,
  messages: StoredMessage[],
  opts: { markResponseComplete?: boolean } = {},
): Promise<void> {
  if (!Array.isArray(messages)) return;
  await convex().mutation(api.sessions.persistTranscript, {
    slug,
    messages,
    markResponseComplete: !!opts.markResponseComplete,
  });
}

export type PushResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

// Meta workspace push: walk every clone under PROJECT_PATH, push the ones
// with commits ahead of upstream, and report uncommitted work per repo.
function buildMetaPushCommand(): string {
  return [
    `for d in ${PROJECT_PATH}/*/;`,
    `do [ -d "$d/.git" ] || continue;`,
    `name=$(basename "$d");`,
    `ahead=$(git -c safe.directory='*' -C "$d" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0);`,
    `if [ "$ahead" -gt 0 ]; then`,
    `echo "== $name: pushing $ahead commit(s)";`,
    `git -c safe.directory='*' -C "$d" push 2>&1;`,
    `else echo "== $name: nothing to push";`,
    `fi;`,
    `dirty=$(git -c safe.directory='*' -C "$d" status --short | head -8);`,
    `if [ -n "$dirty" ]; then echo "   uncommitted in $name:"; echo "$dirty"; fi;`,
    `done`,
  ].join(" ");
}

export async function pushSession(slug: string): Promise<PushResult> {
  const expectedRepo = getRepoForSlug(slug);
  if (!expectedRepo) {
    return { exitCode: -1, stdout: "", stderr: `Unknown slug: ${slug}` };
  }
  const session = await getActiveSession(slug);
  if (!session) {
    return { exitCode: -1, stdout: "", stderr: `No active session for ${slug}` };
  }
  if (session.status !== "ready") {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `Session not ready (status: ${session.status})`,
    };
  }
  if (session.repo !== expectedRepo) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `Session repo mismatch (${session.repo} vs ${expectedRepo}); refusing push.`,
    };
  }

  const isMeta = slug === META_SLUG;
  const c = agentClient();
  const r = await c.sandboxes.exec({
    sandboxId: session.sandboxId,
    command: isMeta
      ? buildMetaPushCommand()
      : `git -c safe.directory='*' -C ${PROJECT_PATH} status --short && ` +
        `git -c safe.directory='*' -C ${PROJECT_PATH} log --oneline -5 && ` +
        `echo '---PUSH---' && ` +
        `git -c safe.directory='*' -C ${PROJECT_PATH} push 2>&1`,
    timeoutMs: isMeta ? 120_000 : 50_000,
  });

  await convex().mutation(api.sessions.bumpLastActive, {
    sandboxId: session.sandboxId,
  });

  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

const SUMMARY_PROMPT = `You are wrapping up a session inside /workspace/project. Write a concise log (UNDER 1800 characters TOTAL) of this session to /home/user/.hub/context.md as plain markdown. Include:

- "## Built" — what was added or changed (use git log -n 10 --oneline and git diff --stat HEAD~1)
- "## Open" — what is unfinished, pending, or has known issues
- "## Next" — one or two suggested next steps for the future you

Be terse. Bullet points. No fluff. Hard cap 1800 chars. After writing the file, reply only with "saved".`;

const SUMMARY_WAIT_SECONDS = 35;

export async function writeSessionLog(
  slug: string,
  sandboxId: string,
): Promise<void> {
  const c = agentClient();
  const summaryThread = await c.threads.create({
    sandboxId,
    name: `_summary_${Date.now()}`,
  });
  await c.threads.run({
    agent: "hub-tester",
    sandboxId,
    threadId: summaryThread.id,
    messages: [
      { role: "user", parts: [{ type: "text", text: SUMMARY_PROMPT }] },
    ],
    mode: "background",
  });

  const deadline = Date.now() + SUMMARY_WAIT_SECONDS * 1000;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const t = await c.threads
      .get({ sandboxId, threadId: summaryThread.id })
      .catch(() => null);
    if (!t) break;
    if (t.status === "completed" || t.status === "error") {
      done = true;
      break;
    }
  }
  if (!done) {
    await c.threads
      .delete({ sandboxId, threadId: summaryThread.id })
      .catch(() => {});
    return;
  }

  const fileRead = await c.sandboxes
    .exec({
      sandboxId,
      command: "cat /home/user/.hub/context.md 2>/dev/null | head -c 4000",
      timeoutMs: 8_000,
    })
    .catch(() => null);

  await c.threads
    .delete({ sandboxId, threadId: summaryThread.id })
    .catch(() => {});

  const summary = (fileRead?.stdout || "").trim();
  if (!summary) return;
  const truncated = summary.length > 2000 ? summary.slice(0, 2000) : summary;
  await convex().mutation(api.projectLogs.create, {
    slug,
    summary: truncated,
  });
}

export async function getLatestLog(slug: string): Promise<string | null> {
  const row = (await convex().query(api.projectLogs.getLatest, { slug })) as
    | { summary: string; _creationTime: number }
    | null;
  if (!row?.summary) return null;
  const ts = new Date(row._creationTime).toISOString();
  return `# Previous session log (${ts})\n\n${row.summary}\n`;
}
