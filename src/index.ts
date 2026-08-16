import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { KsiegaiMcp } from "./mcp-agent";
import { resolveAccessToken } from "./auth";
import { defaultHandler } from "./oauth";

export { KsiegaiMcp };

// McpAgent.serve()'s handler reads `ctx.props` off the ExecutionContext and
// calls `agent.updateProps(ctx.props)` before dispatching to the Durable
// Object — confirmed by reading node_modules/agents/dist/mcp directly. This
// is the same hook `OAuthProvider`'s apiHandler dispatch uses (it sets
// ctx.props itself, from the OAuth grant's decrypted props, before calling
// this), so this one apiHandler serves both auth paths below unchanged.
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return KsiegaiMcp.serve("/mcp", { binding: "KsiegaiMcp" }).fetch(request, env, ctx);
  },
};

// OAuth auto-connect (T-418 continuation, 2026-08-15) — see
// README_AGENT.md's "OAuth auto-connect" section and src/oauth.ts for the
// full flow. Dynamic Client Registration (RFC 7591) enabled 2026-08-17 so
// any MCP client (Claude Code, Claude Desktop, Codex, etc.) can self-
// register a client_id on first "connect" with no manual
// /admin/register-client round-trip — the standard shape for "click
// connect" remote MCP servers. This only lets a client register itself an
// OAuth *client* record; it still can't reach any accounting data without
// a human logging in and approving a specific business/tier on
// McpAuthorize.tsx, so DCR doesn't weaken the real access boundary.
const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 3600,
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Legacy manual mcp_... bearer path (Phase 1, T-418) — bypasses
    // OAuthProvider entirely, byte-for-byte unchanged from before this
    // pass, so the "copy a token into your MCP client config" flow keeps
    // working for scripted/headless use. Only intercepted for /mcp itself
    // and only when the bearer actually looks like a legacy token — every
    // other path (including /mcp with no/other bearer, /authorize,
    // /oauth/token, /authorize/complete, /admin/*) goes through
    // oauthProvider.fetch, which owns all of those.
    if (url.pathname.startsWith("/mcp")) {
      const authHeader = request.headers.get("authorization") ?? "";
      if (/^Bearer\s+mcp_/i.test(authHeader)) {
        const props = await resolveAccessToken(request);
        if (!props) {
          return new Response(JSON.stringify({ error: "unauthorized", message: "Missing or malformed bearer token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        (ctx as ExecutionContext & { props?: unknown }).props = props;
        return apiHandler.fetch(request, env, ctx);
      }
    }

    return oauthProvider.fetch(request, env, ctx);
  },
};
