/**
 * Vault client — reads secrets from the project-hub Convex `secrets` table at
 * runtime. Apps never hardcode credentials; they pull scoped to the service
 * they need. No secret value is ever logged.
 *
 * Endpoint contract (project-hub Convex):
 *   POST {VAULT_URL}/api/query  body { path, args, format:"json" }
 *   - secrets:listByService -> { status, value: Secret[] }
 */

const DEFAULT_VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";

export interface VaultSecret {
  service: string;
  keyName: string;
  value: string;
  aliases?: string[];
}

function vaultUrl(): string {
  return (process.env.VAULT_URL ?? DEFAULT_VAULT_URL).replace(/\/$/, "");
}

/** List all secrets for a service as a flat { keyName: value } map (aliases included). */
export async function listByService(service: string): Promise<Record<string, string>> {
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const res = await fetch(`${vaultUrl()}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service, vaultToken },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`vault listByService(${service}) -> HTTP ${res.status}`);
  const json = (await res.json()) as { status?: string; value?: VaultSecret[]; errorMessage?: string };
  if (json.status && json.status !== "success") {
    throw new Error(`vault listByService(${service}) -> ${json.errorMessage ?? json.status}`);
  }
  const out: Record<string, string> = {};
  for (const s of json.value ?? []) {
    out[s.keyName] = s.value;
    for (const alias of s.aliases ?? []) out[alias] = s.value;
  }
  return out;
}

/**
 * Hydrate process.env from a vault service. Idempotent: never overwrites a key
 * already present (an explicit Trigger-deployed env var always wins). Returns
 * the key names loaded (NOT values).
 */
export async function hydrateEnv(service: string): Promise<string[]> {
  const map = await listByService(service);
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (!process.env[k]) {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}
