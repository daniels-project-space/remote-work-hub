import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Called by the Trigger spike task (public, via the HTTP /api/mutation route). */
export const record = mutation({
  args: { at: v.number(), ok: v.boolean(), detail: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("spikeResults", args);
  },
});

/** Read the most recent spike result (via HTTP /api/query). */
export const latest = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("spikeResults").order("desc").take(1);
    return rows[0] ?? null;
  },
});
