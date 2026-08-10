export interface McpProps extends Record<string, unknown> {
  supabaseAccessToken: string;
}

/**
 * Phase 0 (this slice): the MCP bearer token IS the caller's real ksiegai
 * (Supabase) session token — same trust model ksiegai-gateway's own
 * requireSession already uses for legacy HS256 tokens (can't verify the
 * signature here without holding the shared secret, so this only checks a
 * token is present; the gateway + Postgres RLS are the real enforcement
 * point downstream). That means an MCP client today gets the FULL scope of
 * the user's own session, not a narrowed grant — acceptable for a single
 * trusted dev testing this end-to-end, not for shipping to real users.
 *
 * Next step (tracked in ksef-ai docs/todo/queue.md T-418, not built yet):
 * a `mcp_access_tokens` table + gateway-issued, business-scoped, tiered
 * (read-only / draft-write / full-post) tokens, so this function resolves
 * an opaque `mcp_...` token to a narrow grant instead of accepting a raw
 * session token 1:1.
 */
export function resolveAccessToken(request: Request): McpProps | null {
  const header = request.headers.get("authorization");
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  return { supabaseAccessToken: token };
}
