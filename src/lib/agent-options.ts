export const CODEX_PRESETS = {
  fast: {
    label: "Fast",
    model: "gpt-5.6-terra",
    effort: "low",
    description: "Quick fixes, searches, and routine maintenance.",
  },
  balanced: {
    label: "Balanced",
    model: "gpt-5.6-sol",
    effort: "medium",
    description: "Default for normal implementation work.",
  },
  deep: {
    label: "Deep",
    model: "gpt-5.6",
    effort: "high",
    description: "Architecture, debugging, and consequential changes.",
  },
  max: {
    label: "Max",
    model: "gpt-5.6",
    effort: "xhigh",
    description: "Hardest tasks; slowest and uses the most subscription tokens.",
  },
} as const;

export const CLAUDE_PRESETS = {
  fast: { label: "Fast", model: "haiku", description: "Quick fixes, searches, and routine maintenance." },
  balanced: { label: "Balanced", model: "sonnet", description: "Default for normal implementation work." },
  deep: { label: "Deep", model: "opus", description: "Architecture, debugging, and consequential changes." },
  max: { label: "Max", model: "opus", description: "Hardest tasks; uses the strongest Claude subscription model." },
} as const;

export type AgentProvider = "codex" | "claude";

export type CodexPreset = keyof typeof CODEX_PRESETS;

export function isCodexPreset(value: string): value is CodexPreset {
  return Object.prototype.hasOwnProperty.call(CODEX_PRESETS, value);
}

export function isAgentProvider(value: string): value is AgentProvider {
  return value === "codex" || value === "claude";
}
