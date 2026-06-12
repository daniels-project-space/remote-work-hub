import "server-only";

// SERVER-ONLY slug -> GitHub repo map. Never imported by client code.
// Cross-contamination defense: every server-side write/push derives the repo
// from this table, NOT from anything the client sends.
export const PROJECT_REPOS: Record<string, string> = {
  "music-house": "daniels-project-space/music-house",
  "rental-manager-v2": "daniels-project-space/rental-manager-v2",
  "youtube-studio-ai": "daniels-project-space/youtube-studio-ai",
  "db-cinema-v2": "daniels-project-space/db-cinema-v2",
  "finance-engine-v2": "daniels-project-space/finance-engine-v2",
};

// Meta workspace: ONE sandbox with every repo cloned side-by-side under
// /workspace/project/<dir> — the project-hub dashboard, this hub itself, and
// every registered project. Spawn + push special-case this slug in
// lib/sessions.ts (multi-repo clone, per-repo push). repo label is the org so
// the UI's GitHub link lands on the org page.
export const META_SLUG = "hq";
export const META_REPO_LABEL = "daniels-project-space";
export const META_REPOS: Record<string, string> = {
  "project-hub": "daniels-project-space/project-hub",
  "remote-work-hub": "daniels-project-space/remote-work-hub",
  ...PROJECT_REPOS,
};

export type ProjectMeta = {
  slug: string;
  name: string;
  description: string;
  repo: string;
  // Vault services to fetch and inject into the sandbox as env vars.
  // Each entry maps to a 'service' in the project-hub Convex secrets table.
  // Setup script pulls every key under those services and writes them to .env.local.
  services?: string[];
};

// Public-safe project metadata (no secrets, no token URLs). Safe to ship to
// the browser via server components.
export const PROJECTS: ProjectMeta[] = [
  {
    slug: META_SLUG,
    name: "HQ — All Projects",
    description:
      "Meta workspace: every repo cloned side-by-side — project-hub dashboard, remote-work-hub itself, and all project workspaces. Edit anything; Push syncs each repo that has new commits.",
    repo: META_REPO_LABEL,
    services: ["convex", "vercel", "cloudflare", "trigger", "anthropic", "openrouter", "21st"],
  },
  {
    slug: "music-house",
    name: "Music House",
    description:
      "AI music label. Suno + Mureka generation, organized catalog with timestamped lyrics, hearts, playlists, distribution-ready.",
    repo: "daniels-project-space/music-house",
    services: ["convex", "cloudflare", "suno", "mureka", "kits", "anthropic", "replicate", "trigger"],
  },
  {
    slug: "rental-manager-v2",
    name: "Rental Manager v2",
    description:
      "Hygglo rental bot + dashboard. READ-ONLY mode by default; outbound messaging gated behind ALLOW_HYGGLO_SEND flag.",
    repo: "daniels-project-space/rental-manager-v2",
    services: ["convex", "vercel", "cloudflare", "r2-rental-manager-v2", "trigger", "browserbase", "xai", "anthropic", "hygglo-leo", "hygglo-dbcinema", "telegram-rental-v2", "rental-manager-v2"],
  },
  {
    slug: "youtube-studio-ai",
    name: "YouTube Studio AI",
    description:
      "Modular AI YouTube video factory — block-based pipeline (Convex + Mastra + Trigger + R2 + Higgsfield).",
    repo: "daniels-project-space/youtube-studio-ai",
    services: ["convex", "cloudflare", "trigger", "higgsfield", "suno", "mureka", "youtube", "telegram", "replicate"],
  },
  {
    slug: "db-cinema-v2",
    name: "Db Cinema Rentals",
    description:
      "Standalone transactional film-gear rental storefront. Availability sourced from rental-manager-v2 (Hygglo ledger) via bridge; Stripe payments + deposits.",
    repo: "daniels-project-space/db-cinema-v2",
    services: ["convex", "vercel", "cloudflare", "trigger", "anthropic"],
  },
  {
    slug: "finance-engine-v2",
    name: "Finance Engine v2",
    description:
      "Self-improving crypto strategy lab. DSL expression-graph strategies, statistical gauntlet (walk-forward, DSR, sealed holdout), 30-day paper incubation, champion/challenger auto-promotion.",
    repo: "daniels-project-space/finance-engine-v2",
    services: ["convex", "cloudflare", "trigger", "anthropic", "openrouter", "telegram", "finance-engine-v2"],
  },
];

export function getRepoForSlug(slug: string): string | null {
  if (slug === META_SLUG) return META_REPO_LABEL;
  return PROJECT_REPOS[slug] ?? null;
}

export function getServicesForSlug(slug: string): string[] {
  const meta = PROJECTS.find((p) => p.slug === slug);
  return meta?.services ?? [];
}
