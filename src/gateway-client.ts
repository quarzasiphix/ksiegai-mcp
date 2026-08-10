/**
 * Calls ksiegai-gateway's generic action-dispatched proxy
 * (POST /v1/workspace, { action: "domain.verb", ...params }) over the
 * Service Binding declared in wrangler.jsonc — worker-to-worker, no public
 * network hop. The gateway forwards the bearer token to ksef-ai's
 * `ksiegai-workspace` edge function, which resolves the caller and enforces
 * access via its own per-action auth + Postgres RLS. This Worker never
 * talks to Postgres or holds any Supabase service-role key.
 */
export async function callWorkspace(
  env: Env,
  supabaseAccessToken: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await env.GATEWAY.fetch("https://internal/v1/workspace", {
    method: "POST",
    headers: {
      authorization: `Bearer ${supabaseAccessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, ...params }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? JSON.stringify(body.error) : response.statusText;
    throw new Error(`gateway ${action} failed (${response.status}): ${message}`);
  }
  return body;
}
