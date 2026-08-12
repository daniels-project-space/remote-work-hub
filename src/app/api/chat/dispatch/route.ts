import { tasks } from "@trigger.dev/sdk";
import { NextResponse, type NextRequest } from "next/server";
import type { chatDispatcher } from "@/trigger/chat-session";

export const runtime = "nodejs";

/**
 * Starts the queue drain only after a user message is durable in Convex.
 * Idempotency makes client retries safe while avoiding the old idle cron.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const messageId = body?.messageId;
    if (typeof messageId !== "string" || messageId.length === 0) {
      return NextResponse.json({ error: "messageId required" }, { status: 400 });
    }

    const handle = await tasks.trigger<typeof chatDispatcher>(
      "chat-dispatcher",
      { messageId },
      {
        idempotencyKey: `chat-dispatch:${messageId}`,
        idempotencyKeyTTL: "1h",
      },
    );
    return NextResponse.json({ runId: handle.id });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unable to start the agent";
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}
