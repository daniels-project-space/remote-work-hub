"use client";
import ConvexChatClient from "./convex-chat-client";

/**
 * Cloud chat shell. The 21st sandbox spawn flow is gone — compute now runs in
 * the Trigger `chat-dispatcher` task on ChatGPT-managed subscription auth. This just mounts
 * the Convex-backed chat for the project; no sandbox to start.
 */
export default function ProjectShell({
  slug,
  repo,
}: {
  slug: string;
  repo: string;
}) {
  return <ConvexChatClient slug={slug} repo={repo} />;
}
