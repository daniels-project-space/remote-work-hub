# Subscription-backed Codex dispatcher

Project chat runs `codex exec` inside the private Trigger.dev worker. It clears
`OPENAI_API_KEY` and `CODEX_API_KEY`, so work uses ChatGPT-managed Codex access
rather than OpenAI Platform API credits.

The UI exposes four explicit presets:

- Fast — `gpt-5.6-terra`, low reasoning
- Balanced — `gpt-5.6-sol`, medium reasoning
- Deep — `gpt-5.6`, high reasoning
- Max — `gpt-5.6`, xhigh reasoning

For Business/Enterprise trusted automation, set `CODEX_ACCESS_TOKEN` in the
Trigger project. For a saved ChatGPT CLI login, set `CODEX_AUTH_JSON_B64` to the
base64 encoding of the machine's Codex `auth.json`. Treat either value as a
password. Never commit it or put it in the Project Hub's anonymously readable
vault. The deploy config can sync `CODEX_AUTH_JSON_B64` from a one-use local env
file into Trigger's managed environment.

The dispatcher requires `GITHUB_TOKEN` for private clone/push access. Jarvis,
App Factory v2, and every other project are selected from server-owned
allowlists; the HQ workspace discovers additional active organization repos at
runtime.
