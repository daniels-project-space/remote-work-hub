import { defineConfig } from "@trigger.dev/sdk";
import { additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

/**
 * Trigger.dev config for the Remote Work Hub's own job project.
 *
 * This is what replaces the 21st.dev sandbox runtime for the hub chat: each
 * chat turn runs Codex headlessly inside this Trigger image, authenticated with
 * ChatGPT-managed credentials (CODEX_ACCESS_TOKEN or CODEX_AUTH_JSON_B64) —
 * never an OpenAI Platform API key.
 *
 * Pattern mirrors youtube-studio-ai, which already runs the Higgsfield CLI in a
 * Trigger task on subscription creds. Proven approach, copied deliberately.
 *
 * - @openai/codex is baked into the image via additionalPackages so the
 *   `codex` binary is present at runtime with no setup step.
 * - git is needed to clone/commit/push the target repo; baked via aptGet.
 * - project ref defaults to the org's provisioned Trigger project and can be
 *   overridden with TRIGGER_PROJECT_REF for portability.
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_oqwizuikmyjdfuzbetda",
  runtime: "node",
  logLevel: "log",
  dirs: ["./src/trigger"],
  maxDuration: 3600, // 1h ceiling per chat turn; real turns finish in seconds.
  build: {
    // Codex spawns its own subprocesses and reads its bundled binary from
    // disk — keep it OUT of the esbuild bundle and let Trigger install it fresh
    // in the Linux image (correct platform binary).
    external: ["@openai/codex", "@anthropic-ai/claude-code"],
    extensions: [
      additionalPackages({ packages: ["@openai/codex@latest", "@anthropic-ai/claude-code@latest"] }),
      aptGet({ packages: ["git", "ca-certificates"] }),
      // Deployment-only bridge: pass CODEX_AUTH_JSON_B64 in the CLI environment
      // and Trigger stores it as a managed runtime secret. If it is absent,
      // existing cloud env vars are left untouched.
      syncEnvVars(() => {
        const value = process.env.CODEX_AUTH_JSON_B64;
        return value ? { CODEX_AUTH_JSON_B64: value } : undefined;
      }),
    ],
  },
});
