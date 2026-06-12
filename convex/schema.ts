import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({
    slug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    githubRepo: v.optional(v.string()),
    vercelProjectId: v.optional(v.string()),
    status: v.string(),
  }).index("by_slug", ["slug"]),

  sessions: defineTable({
    projectSlug: v.string(),
    sandboxId: v.string(),
    threadId: v.optional(v.union(v.string(), v.null())),
    repo: v.string(),
    status: v.union(
      v.literal("spawning"),
      v.literal("ready"),
      v.literal("dead"),
    ),
    transcript: v.optional(v.array(v.any())),
    startedAt: v.number(),
    lastActiveAt: v.number(),
    lastResponseAt: v.optional(v.union(v.number(), v.null())),
    endedAt: v.optional(v.union(v.number(), v.null())),
  })
    .index("by_slug_and_status", ["projectSlug", "status"])
    .index("by_slug", ["projectSlug"])
    .index("by_status", ["status"])
    .index("by_sandbox", ["sandboxId"]),

  projectLogs: defineTable({
    projectSlug: v.string(),
    summary: v.string(),
  }).index("by_slug", ["projectSlug"]),

  // ── Cloud chat (Trigger.dev + Claude Code on subscription) ──────────────
  // One row per project; tracks Claude session continuity + working state.
  chatSessions: defineTable({
    projectSlug: v.string(),
    repo: v.string(),
    status: v.union(v.literal("idle"), v.literal("working")),
    claudeSessionId: v.optional(v.string()),
    lastActiveAt: v.number(),
  }).index("by_slug", ["projectSlug"]),

  // Chat transcript. user messages start "pending" (awaiting the dispatcher);
  // assistant messages stream "streaming" -> "done"/"error".
  chatMessages: defineTable({
    projectSlug: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("error"),
    ),
    createdAt: v.number(),
    // populated on assistant messages when the turn finishes
    pushResult: v.optional(v.string()),
  })
    .index("by_slug", ["projectSlug"])
    .index("by_status", ["status"]),

  // Temporary spike scaffold (proven). Safe to drop later.
  spikeResults: defineTable({
    at: v.number(),
    ok: v.boolean(),
    detail: v.string(),
  }),
});
