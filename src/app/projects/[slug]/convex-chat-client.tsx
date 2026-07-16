"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { CODEX_PRESETS, type CodexPreset } from "@/lib/agent-options";

type Msg = {
  _id: string;
  role: "user" | "assistant";
  text: string;
  status: "pending" | "streaming" | "done" | "error";
  createdAt: number;
  pushResult?: string;
};

export default function ConvexChatClient({
  slug,
  repo,
}: {
  slug: string;
  repo: string;
}) {
  const messages = useQuery(api.chat.listMessages, { projectSlug: slug }) as
    | Msg[]
    | undefined;
  const session = useQuery(api.chat.sessionState, { projectSlug: slug });
  const sendMessage = useMutation(api.chat.sendMessage);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [agentPreset, setAgentPreset] = useState<CodexPreset>("balanced");
  const scrollRef = useRef<HTMLDivElement>(null);

  const ordered = useMemo(
    () => (messages ?? []).slice().sort((a, b) => a.createdAt - b.createdAt),
    [messages],
  );

  const last = ordered[ordered.length - 1];
  // The agent is "thinking" when the newest message is the user's (no assistant
  // bubble yet) or an assistant bubble exists but hasn't produced text. Covers
  // the ≤60s gap before the cloud dispatcher picks the turn up.
  const thinking =
    !!last &&
    (last.role === "user" ||
      (last.role === "assistant" &&
        last.status === "streaming" &&
        last.text.length === 0));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [ordered, thinking]);

  const working = session?.status === "working";

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    try {
      await sendMessage({ projectSlug: slug, repo, text, agentPreset });
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="min-h-dvh flex flex-col max-w-3xl mx-auto w-full">
      <header className="sticky top-0 z-10 px-5 sm:px-8 pt-6 pb-4 bg-ink/80 backdrop-blur-sm border-b border-paper/10">
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-[0.28em] text-paper-faint hover:text-amber transition-colors"
        >
          ← back
        </Link>
        <div className="mt-3 flex items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl sm:text-3xl italic text-paper truncate">
            {slug}
          </h1>
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.24em] shrink-0 ${
              working || thinking ? "text-amber" : "text-paper-faint"
            }`}
          >
            {working || thinking ? "● working" : "idle"}
          </span>
        </div>
        <p className="mt-1 font-mono text-[11px] text-paper-dim truncate">{repo}</p>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 sm:px-8 py-6 space-y-5"
      >
        {messages === undefined ? (
          <p className="font-mono text-[11px] text-paper-faint">loading…</p>
        ) : ordered.length === 0 ? (
          <div className="mt-10 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-paper-faint">
              cloud agent · ready
            </p>
            <p className="mt-3 text-sm text-paper-dim max-w-sm mx-auto leading-relaxed">
              Ask anything or describe a change. Codex runs in the cloud on your
              ChatGPT subscription, edits {repo}, and pushes when done.
            </p>
          </div>
        ) : (
          ordered.map((m) => (
            <div
              key={m._id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words ${
                  m.role === "user"
                    ? "bg-amber/15 text-paper rounded-2xl rounded-br-sm"
                    : "bg-paper/[0.04] border border-paper/10 text-paper rounded-2xl rounded-bl-sm"
                }`}
              >
                {m.text ||
                  (m.role === "assistant" && m.status === "streaming" ? "…" : "")}
                {m.role === "assistant" && m.status === "streaming" && m.text && (
                  <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-amber/70 animate-pulse" />
                )}
                {m.status === "error" && !m.text && (
                  <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-rose-soft">
                    error
                  </span>
                )}
                {m.pushResult &&
                  m.pushResult !== "nothing to push" &&
                  m.pushResult !== "no repo" && (
                    <span className="block mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-faint">
                      {m.pushResult}
                    </span>
                  )}
              </div>
            </div>
          ))
        )}

        {thinking && (
          <div className="flex justify-start">
            <div className="max-w-[85%] px-4 py-3 bg-paper/[0.04] border border-paper/10 rounded-2xl rounded-bl-sm">
              <div className="flex items-center gap-2">
                <span className="flex gap-1" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-amber/70"
                      style={{
                        animation: `pulse-dot 1.2s ease-in-out ${i * 0.15}s infinite`,
                      }}
                    />
                  ))}
                </span>
                <span className="font-mono text-[11px] text-paper-dim">
                  agent is working…
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="sticky bottom-0 px-5 sm:px-8 py-4 bg-ink/80 backdrop-blur-sm border-t border-paper/10">
        <div className="mb-2 flex items-center gap-2 overflow-x-auto pb-1">
          {(Object.entries(CODEX_PRESETS) as [CodexPreset, (typeof CODEX_PRESETS)[CodexPreset]][]).map(
            ([key, preset]) => (
              <button
                key={key}
                type="button"
                title={`${preset.model} · ${preset.effort} reasoning · ${preset.description}`}
                onClick={() => setAgentPreset(key)}
                className={`shrink-0 rounded-lg border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                  agentPreset === key
                    ? "border-amber/60 bg-amber/15 text-amber"
                    : "border-paper/10 text-paper-faint hover:border-paper/25 hover:text-paper-dim"
                }`}
              >
                {preset.label}
              </button>
            ),
          )}
          <span className="ml-auto shrink-0 font-mono text-[9px] text-paper-faint">
            {CODEX_PRESETS[agentPreset].model} · {CODEX_PRESETS[agentPreset].effort}
          </span>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={1}
            placeholder="Message the agent…"
            className="flex-1 resize-none max-h-40 bg-paper/[0.04] border border-paper/15 rounded-xl px-4 py-3 text-[15px] text-paper placeholder:text-paper-faint focus:outline-none focus:border-amber/50"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!draft.trim() || sending}
            className="shrink-0 font-mono text-[11px] uppercase tracking-[0.2em] px-4 py-3 bg-amber text-ink rounded-xl disabled:opacity-40 transition-opacity"
          >
            send
          </button>
        </div>
        <p className="mt-2 font-mono text-[10px] text-paper-faint">
          First reply can take up to a minute · then follow-ups are quick · changes auto-push to {repo}
        </p>
      </div>
    </main>
  );
}
