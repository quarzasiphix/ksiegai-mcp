export interface McpProps extends Record<string, unknown> {
  mcpTokenHash: string;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Phase 1 (T-418, replaces Phase 0): the MCP bearer is an opaque `mcp_...`
 * token issued from ksiegai's Settings -> "Połącz AI (MCP)" screen
 * (McpConnect.tsx), one per connection, scoped to a single business
 * profile + permission tier, revocable, optionally expiring. Hashed HERE,
 * once, before it ever reaches the Durable Object — the raw token never
 * enters KsiegaiMcp's props/memory, only its hash.
 *
 * Every tool call re-exchanges this hash for a short-lived real Supabase
 * session JWT via public-api's `mcp.authenticate` action (see
 * gateway-client.ts's authenticateMcpCall, called from mcp-agent.ts's
 * call/callBank wrappers) — revocation/expiry/scope/tier are checked FRESH
 * on every call, never cached here, so a revoked connection stops working
 * on its very next tool call, not just at reconnect.
 */
export async function resolveAccessToken(request: Request): Promise<McpProps | null> {
  const header = request.headers.get("authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !token.startsWith("mcp_")) return null;
  return { mcpTokenHash: await sha256Hex(token) };
}
