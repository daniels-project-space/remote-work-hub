"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { type ReactNode, useMemo } from "react";

/**
 * Wraps the app in a Convex client so the cloud chat (chatMessages /
 * chatSessions on the hub deployment) can be live-queried from the browser.
 * NEXT_PUBLIC_CONVEX_URL is already set in the hub's Vercel env.
 */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(
    () => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL as string),
    [],
  );
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
