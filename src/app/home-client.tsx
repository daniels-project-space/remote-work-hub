"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSessions } from "@/components/session-provider";
import type { ProjectMeta } from "@/lib/projects";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

const FRESH_WINDOW_MS = 10_000; // session counts as "just responded" for 10s

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function HomeClient({ projects }: { projects: ProjectMeta[] }) {
  const { sessions, end, refresh } = useSessions();
  const [endingSlug, setEndingSlug] = useState<string | null>(null);
  // Tick state so the glow fades naturally as time passes
  const [now, setNow] = useState(() => Date.now());

  // Tick fast so the 10s "responded" window fades smoothly off-screen
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Poll session list every 1s so a fresh response shows on the hub within ~1s
  useEffect(() => {
    const id = setInterval(() => void refresh(), 1_000);
    return () => clearInterval(id);
  }, [refresh]);

  const sessionBySlug = useMemo(() => {
    const map: Record<string, (typeof sessions)[number]> = {};
    for (const s of sessions) map[s.slug] = s;
    return map;
  }, [sessions]);

  // Use lastResponseAt (only updated on streaming→ready) so the badge fires
  // strictly when the agent finishes — not during streaming.
  function isFresh(s: { lastResponseAt: string | null } | undefined): boolean {
    if (!s?.lastResponseAt) return false;
    return now - new Date(s.lastResponseAt).getTime() < FRESH_WINDOW_MS;
  }

  const handleEnd = async (slug: string) => {
    setEndingSlug(slug);
    try {
      await end(slug);
    } finally {
      setEndingSlug(null);
    }
  };

  return (
    <main className="min-h-dvh">
      <header className="border-b border-rule-soft/60">
        <div className="max-w-[1440px] mx-auto px-8 lg:px-14 pt-12 pb-10 flex items-end justify-between gap-8">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-amber/80">
              Remote Work / 2026
            </p>
            <h1 className="mt-2 font-display text-[64px] leading-[1.02] tracking-tight text-paper">
              Remote Work{" "}
              <span className="italic text-paper-dim">Hub</span>
            </h1>
            <p className="mt-3 max-w-xl text-paper-dim text-[15px] leading-relaxed">
              A launcher for cloud Codex agents using ChatGPT subscription credits. Each project gets its
              own sandbox; jump in and out — sessions stay alive until you end
              them.
            </p>
          </div>

          <div className="hidden md:flex items-center gap-6 text-right">
            <a
              href="https://project-hub-olive-pi.vercel.app"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] uppercase tracking-[0.28em] text-paper-faint hover:text-amber transition-colors"
              aria-label="Open Project Hub"
            >
              ← Project Hub
            </a>
            <div className="h-12 w-px bg-rule-soft" />
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-paper-faint">
                Projects
              </p>
              <p className="font-display text-3xl text-paper mt-1 tabular-nums">
                {String(projects.length).padStart(2, "0")}
              </p>
            </div>
            <div className="h-12 w-px bg-rule-soft" />
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-paper-faint">
                Live Sessions
              </p>
              <p className="font-display text-3xl text-paper mt-1 tabular-nums flex items-center justify-end gap-2">
                {sessions.length > 0 && (
                  <span className="w-2 h-2 rounded-full bg-amber pulse-dot" />
                )}
                {String(sessions.length).padStart(2, "0")}
              </p>
            </div>
          </div>
        </div>
      </header>

      <AnimatePresence>
        {sessions.length > 0 && (
          <motion.section
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="border-b border-rule-soft/60 overflow-hidden bg-amber/[0.02]"
          >
            <div className="max-w-[1440px] mx-auto px-8 lg:px-14 py-5 flex items-center gap-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-amber/80 shrink-0">
                Live · Jump back in
              </p>
              <div className="h-5 w-px bg-rule-soft" />
              <div className="flex-1 flex flex-wrap gap-2">
                {sessions.map((s) => (
                  <div
                    key={s.slug}
                    className="group flex items-center gap-3 border border-rule pl-3 pr-1 py-1 hover:border-amber/40 transition-colors"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber pulse-dot shrink-0" />
                    <Link
                      href={`/projects/${s.slug}`}
                      className="text-sm text-paper hover:text-amber transition-colors"
                    >
                      {s.slug}
                    </Link>
                    <span className="font-mono text-[10px] text-paper-faint">
                      {formatRelative(s.lastActiveAt)} ago
                    </span>
                    <button
                      type="button"
                      onClick={() => handleEnd(s.slug)}
                      disabled={endingSlug === s.slug}
                      className="ml-1 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-faint hover:text-rose-soft px-2 py-1 transition-colors disabled:opacity-50"
                    >
                      {endingSlug === s.slug ? "…" : "end"}
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-faint hover:text-amber transition-colors shrink-0"
              >
                refresh
              </button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <section className="max-w-[1440px] mx-auto px-8 lg:px-14 py-12">
        <div className="flex items-baseline justify-between mb-8">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.32em] text-paper-faint">
            Projects
          </h2>
          <p className="font-mono text-[11px] text-paper-faint">
            Click any tile to open or rejoin its session
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-rule-soft/40">
          {projects.map((p, idx) => {
            const session = sessionBySlug[p.slug];
            const live = !!session;
            const fresh = isFresh(session);
            return (
              <Link
                key={p.slug}
                href={`/projects/${p.slug}`}
                className={cn(
                  "group relative bg-ink hover:bg-ink-2 transition-all p-7 min-h-[220px] flex flex-col justify-between",
                  live && !fresh && "ring-1 ring-inset ring-amber/30",
                  fresh &&
                    "ring-1 ring-inset ring-emerald-soft/60 shadow-[0_0_24px_-4px_oklch(0.78_0.13_160_/_0.35)]",
                )}
              >
                <div className="flex items-start justify-between">
                  <span className="font-mono text-[11px] text-paper-faint tracking-wider tabular-nums">
                    /{String(idx + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[10px] uppercase tracking-[0.2em] px-2 py-0.5 flex items-center gap-1.5",
                      fresh
                        ? "text-emerald-soft bg-emerald-soft/[0.12]"
                        : live
                          ? "text-amber bg-amber-glow"
                          : "text-paper-faint bg-rule-soft/40",
                    )}
                  >
                    {(live || fresh) && (
                      <span
                        className={cn(
                          "w-1 h-1 rounded-full pulse-dot",
                          fresh ? "bg-emerald-soft" : "bg-amber",
                        )}
                        style={
                          fresh
                            ? {
                                boxShadow:
                                  "0 0 8px oklch(0.78 0.13 160 / 0.7)",
                              }
                            : undefined
                        }
                      />
                    )}
                    {fresh ? "responded" : live ? "live" : "idle"}
                  </span>
                </div>
                <div>
                  <h3 className="font-display text-2xl text-paper">
                    {p.name}
                  </h3>
                  <p className="mt-2 text-sm text-paper-dim leading-relaxed">
                    {p.description}
                  </p>
                  <div className="mt-5 flex items-center gap-2 font-mono text-[11px] text-paper-faint group-hover:text-amber transition-colors">
                    <span>{live ? "rejoin session" : "open sandbox"}</span>
                    <span className="caret-blink">_</span>
                  </div>
                </div>
                <div
                  className={cn(
                    "absolute inset-x-0 top-0 h-px transition-colors",
                    fresh
                      ? "bg-emerald-soft/70"
                      : live
                        ? "bg-amber/60"
                        : "bg-amber/0 group-hover:bg-amber/60",
                  )}
                />
              </Link>
            );
          })}

          <div className="bg-ink p-7 min-h-[220px] flex flex-col justify-between border border-dashed border-rule-soft/30 m-px">
            <span className="font-mono text-[11px] text-paper-faint">
              /{String(projects.length + 1).padStart(2, "0")}
            </span>
            <div>
              <h3 className="font-display text-2xl italic text-paper-faint">
                Add a project
              </h3>
              <p className="mt-2 text-sm text-paper-faint leading-relaxed">
                Wire it via <code className="font-mono">PROJECT_REPOS</code>.
                UI for this is on the roadmap.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className="max-w-[1440px] mx-auto px-8 lg:px-14 pb-10">
        <div className="rule-hairline mb-4" />
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.28em] text-paper-faint">
          <span>remote-work-hub · vercel · convex · 21st</span>
          <span>v0.2</span>
        </div>
      </footer>
    </main>
  );
}
