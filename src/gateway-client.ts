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
  // Gateway wraps every response as { data: <actual action payload>, meta }
  // (confirmed via a live local call - core.init's businessProfiles sits at
  // .data.businessProfiles, not top-level). Unwrap here so every tool gets
  // the real payload directly, matching the frontend's own
  // callGatewayWorkspace (`return body.data as T`) instead of leaking the
  // envelope shape into every caller.
  return (body as { data?: unknown } | null)?.data ?? body;
}

/** Thrown by authenticateMcpCall — status is the real HTTP status the
 * exchange failed with (401 invalid/revoked/expired, 403 wrong
 * business/tier), so callers can pick a clear message for the AI agent
 * instead of a generic crash. */
export class McpAuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Exchanges the connection's opaque-token hash for a short-lived (10 min)
 * real Supabase session JWT, via public-api's `mcp.authenticate` action
 * (proxied through the gateway's /v1/public route, same Service Binding as
 * every other call here — no public network hop). Called on EVERY tool
 * invocation, not once at connect time, so revocation/expiry/scope/tier
 * are enforced fresh every time — see auth.ts's doc comment.
 */
export async function authenticateMcpCall(
  env: Env,
  tokenHash: string,
  toolName: string,
  businessProfileId?: string,
): Promise<{ accessToken: string; expiresAt: string; authorizedBusinessProfileId: string }> {
  // Dedicated route (not the generic /v1/public proxy) — see
  // ksiegai-gateway/src/routes/public.ts's mcpAuthenticate doc comment:
  // the generic proxy's rate limit is keyed by cf-connecting-ip, which is
  // empty for Service-Binding traffic like this call, so it would share
  // one global budget across every MCP connection instead of none needed
  // (this action's real access control is the token hash's own entropy).
  const response = await env.GATEWAY.fetch("https://internal/v1/public/mcp/authenticate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tokenHash,
      toolName,
      ...(businessProfileId ? { businessProfileId } : {}),
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? typeof (body as { error?: unknown }).error === "object"
          ? ((body as { error?: { message?: string } }).error?.message ?? "auth failed")
          : String((body as { error?: unknown }).error)
        : response.statusText;
    throw new McpAuthError(response.status, message);
  }

  return (body as { data: { accessToken: string; expiresAt: string; authorizedBusinessProfileId: string } }).data;
}

/**
 * Resolves a pending OAuth authorize request (T-418 OAuth auto-connect,
 * 2026-08-15) — called from src/oauth.ts's /authorize/complete handler
 * once the user has approved the connection on ksiegai's consent screen
 * (McpAuthorize.tsx). `requestToken` is the same opaque, single-use, short-
 * TTL value this Worker generated and handed to that screen via the
 * redirect in the first place — its own unguessability + single-use +
 * short expiry IS the authorization here (same protection class as an
 * OAuth authorization code itself), no separate shared secret needed.
 * public-api's `mcp.resolveOAuthConnection` atomically claims the matching
 * mcp_access_tokens row (clears its oauth_request_token so a replay 404s)
 * and returns the connection's hash + owning user + business, which this
 * Worker turns straight into completeAuthorization's `props` — identical
 * shape to the manual mcp_... token path, so every downstream tool call
 * still goes through the normal live authenticateMcpCall check.
 */
export async function resolveOAuthConnection(
  env: Env,
  requestToken: string,
): Promise<{ tokenHash: string; userId: string; businessProfileId: string; agentName: string; permissionTier: string }> {
  const response = await env.GATEWAY.fetch("https://internal/v1/public/mcp/resolve-oauth-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestToken }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? JSON.stringify(body.error) : response.statusText;
    throw new McpAuthError(response.status, message);
  }
  return (body as { data: { tokenHash: string; userId: string; businessProfileId: string; agentName: string; permissionTier: string } }).data;
}

/**
 * Calls ksiegai-gateway's `bank-api` proxy (POST /v1/banking,
 * { action: "kebab-case-verb", ...params } - note: kebab-case action name,
 * NOT the "domain.verb" shape callWorkspace uses; bank-api is a separate
 * edge function with its own action-dispatch convention). Same envelope
 * unwrap as callWorkspace.
 */
export async function callBanking(
  env: Env,
  supabaseAccessToken: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await env.GATEWAY.fetch("https://internal/v1/banking", {
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
  return (body as { data?: unknown } | null)?.data ?? body;
}
