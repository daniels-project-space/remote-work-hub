import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/**
 * Cloud chat transport. The hub UI calls `sendMessage` + subscribes to
 * `listMessages`; the Trigger dispatcher calls `claimNext` / `appendChunk` /
 * `finalize` over the HTTP API. All public (no auth) — personal hub.
 */

async function ensureSession(
  ctx: { db: any },
  projectSlug: string,
  repo: string,
) {
  const existing = await ctx.db
    .query("chatSessions")
    .withIndex("by_slug", (q: any) => q.eq("projectSlug", projectSlug))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert("chatSessions", {
    projectSlug,
    repo,
    status: "idle" as const,
    lastActiveAt: Date.now(),
  });
  return await ctx.db.get(id);
}

/** Hub UI → post a user message (status "pending"; dispatcher picks it up). */
export const sendMessage = mutation({
  args: { projectSlug: v.string(), repo: v.string(), text: v.string() },
  handler: async (ctx, { projectSlug, repo, text }) => {
    await ensureSession(ctx, projectSlug, repo);
    const id = await ctx.db.insert("chatMessages", {
      projectSlug,
      role: "user" as const,
      text,
      status: "pending" as const,
      createdAt: Date.now(),
    });
    return id;
  },
});

/** Hub UI → live transcript for a project, oldest first. */
export const listMessages = query({
  args: { projectSlug: v.string() },
  handler: async (ctx, { projectSlug }) => {
    return await ctx.db
      .query("chatMessages")
      .withIndex("by_slug", (q: any) => q.eq("projectSlug", projectSlug))
      .collect();
  },
});

/** Hub UI → working/idle indicator. */
export const sessionState = query({
  args: { projectSlug: v.string() },
  handler: async (ctx, { projectSlug }) => {
    return await ctx.db
      .query("chatSessions")
      .withIndex("by_slug", (q: any) => q.eq("projectSlug", projectSlug))
      .first();
  },
});

/**
 * Dispatcher → atomically claim the oldest pending user message. Marks it
 * consumed, opens a streaming assistant message, flips the session to
 * "working", and returns everything the task needs (incl. prior transcript for
 * context and the Claude session id for --resume).
 */
export const claimNext = mutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("chatMessages")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .first();
    if (!pending) return null;

    await ctx.db.patch(pending._id, { status: "done" });

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_slug", (q: any) => q.eq("projectSlug", pending.projectSlug))
      .first();
    if (session) {
      await ctx.db.patch(session._id, { status: "working", lastActiveAt: Date.now() });
    }

    const assistantId = await ctx.db.insert("chatMessages", {
      projectSlug: pending.projectSlug,
      role: "assistant" as const,
      text: "",
      status: "streaming" as const,
      createdAt: Date.now(),
    });

    // Prior transcript (everything before this turn), for context.
    const all = await ctx.db
      .query("chatMessages")
      .withIndex("by_slug", (q: any) => q.eq("projectSlug", pending.projectSlug))
      .collect();
    const history = all
      .filter((m: any) => m._id !== assistantId && m._id !== pending._id && m.status === "done")
      .sort((a: any, b: any) => a.createdAt - b.createdAt)
      .slice(-12)
      .map((m: any) => ({ role: m.role, text: m.text }));

    return {
      projectSlug: pending.projectSlug,
      repo: session?.repo ?? "",
      userText: pending.text,
      assistantId,
      claudeSessionId: session?.claudeSessionId ?? null,
      history,
    };
  },
});

/** Dispatcher → append a streamed chunk to an assistant message. */
export const appendChunk = mutation({
  args: { messageId: v.id("chatMessages"), chunk: v.string() },
  handler: async (ctx, { messageId, chunk }) => {
    const m = await ctx.db.get(messageId);
    if (!m) return;
    await ctx.db.patch(messageId, { text: (m.text ?? "") + chunk });
  },
});

/** Dispatcher → close out an assistant message + free the session. */
export const finalize = mutation({
  args: {
    messageId: v.id("chatMessages"),
    projectSlug: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
    claudeSessionId: v.optional(v.string()),
    pushResult: v.optional(v.string()),
    finalText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { status: args.status };
    if (args.pushResult !== undefined) patch.pushResult = args.pushResult;
    if (args.finalText !== undefined) patch.text = args.finalText;
    await ctx.db.patch(args.messageId, patch);

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_slug", (q: any) => q.eq("projectSlug", args.projectSlug))
      .first();
    if (session) {
      const sp: Record<string, unknown> = { status: "idle", lastActiveAt: Date.now() };
      if (args.claudeSessionId) sp.claudeSessionId = args.claudeSessionId;
      await ctx.db.patch(session._id, sp);
    }
  },
});
