import { defineConfig } from "@trigger.dev/sdk";
import { additionalPackages, aptGet } from "@trigger.dev/build/extensions/core";

/**
 * Trigger.dev config for the Remote Work Hub's own job project.
 *
 * This is what replaces the 21st.dev sandbox runtime for the hub chat: each
 * chat turn runs Claude Code HOSTLESS inside this Trigger image, authenticated
 * from an injected subscription token (CLAUDE_CODE_OAUTH_TOKEN) pulled from the
 * project-hub vault at runtime — never the empty platform API-key pool.
 *
 * Pattern mirrors youtube-studio-ai, which already runs the Higgsfield CLI in a
 * Trigger task on subscription creds. Proven approach, copied deliberately.
 *
 * - @anthropic-ai/claude-code is baked into the image via additionalPackages so
 *   the `claude` binary is present at runtime with no setup step.
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
    // Claude Code spawns its own subprocesses and reads its bundled binary from
    // disk — keep it OUT of the esbuild bundle and let Trigger install it fresh
    // in the Linux image (correct platform binary).
    external: ["@anthropic-ai/claude-code"],
    extensions: [
      additionalPackages({ packages: ["@anthropic-ai/claude-code@latest"] }),
      aptGet({ packages: ["git", "ca-certificates"] }),
    ],
  },
});
