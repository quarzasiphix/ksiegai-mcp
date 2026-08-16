// OAuth auto-connect (T-418 continuation, 2026-08-15). This is the
// `defaultHandler` wired into `@cloudflare/workers-oauth-provider`'s
// `OAuthProvider` in src/index.ts — everything that ISN'T a validated
// `/mcp` API call or the library's own built-in `/oauth/token` endpoint
// lands here. Three routes:
//
//   GET  /authorize          - the OAuth entry point an MCP client's
//                               browser opens. We don't render any UI here
//                               at all - ksiegai already has a fully-built
//                               login + business-profile + tier picker
//                               (McpConnect.tsx) in the ksef-ai SPA, and
//                               mcp.ksiegai.pl is a bare Worker with no
//                               React/session of its own. So we just parse
//                               the OAuth request, stash it, and redirect
//                               the browser to a sibling screen in that SPA
//                               (McpAuthorize.tsx) which handles login (if
//                               needed, via its normal route guard) and
//                               consent.
//   GET  /authorize/complete - McpAuthorize.tsx redirects the browser back
//                               here once the user approves. We resolve
//                               what they approved and hand control back to
//                               the OAuth library to mint a real code.
//   POST /admin/register-client - one-off, secret-gated: pre-register a
//                               known MCP client (Claude Code, Claude
//                               Desktop, Codex). No dynamic/self-service
//                               registration is exposed.
//
// See ksiegai-mcp/README_AGENT.md's "OAuth auto-connect" section for the
// full flow diagram and the reasoning behind each hop.

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { resolveOAuthConnection, McpAuthError } from "./gateway-client";

const PENDING_TTL_SECONDS = 600; // 10 minutes - matches the window a user
// realistically needs to notice the browser tab, log in if needed, and
// click approve. Expired pending requests just make /authorize/complete
// 400 with a "start again" message - nothing unsafe about letting this be
// generous, KV eviction handles cleanup either way.

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function htmlError(status: number, title: string, detail: string): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${title}</h1><p>${detail}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return htmlError(400, "Invalid authorization request", err instanceof Error ? err.message : "Could not parse the request.");
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    return htmlError(400, "Unknown client", `"${oauthRequest.clientId}" is not a registered ksiegai MCP client.`);
  }

  const requestToken = randomToken();
  await env.OAUTH_KV.put(`pending:${requestToken}`, JSON.stringify(oauthRequest), { expirationTtl: PENDING_TTL_SECONDS });

  const redirectUrl = new URL(env.APP_AUTHORIZE_URL);
  redirectUrl.searchParams.set("requestToken", requestToken);
  redirectUrl.searchParams.set("client", client.clientName || client.clientId);
  return Response.redirect(redirectUrl.toString(), 302);
}

async function handleAuthorizeComplete(request: Request, env: Env): Promise<Response> {
  const requestToken = new URL(request.url).searchParams.get("requestToken") || "";
  if (!requestToken) {
    return htmlError(400, "Missing requestToken", "This link is incomplete. Start the connection again from your MCP client.");
  }

  const pendingRaw = await env.OAUTH_KV.get(`pending:${requestToken}`);
  if (!pendingRaw) {
    return htmlError(400, "Request expired", "This authorization request has expired or was already used. Start the connection again from your MCP client.");
  }
  const oauthRequest = JSON.parse(pendingRaw) as AuthRequest;

  let connection: Awaited<ReturnType<typeof resolveOAuthConnection>>;
  try {
    connection = await resolveOAuthConnection(env, requestToken);
  } catch (err) {
    if (err instanceof McpAuthError && err.status === 404) {
      return htmlError(400, "Not approved", "No approved connection found for this request. Go back and approve the connection in ksiegai first.");
    }
    return htmlError(502, "Could not complete connection", err instanceof Error ? err.message : "Unknown error.");
  }

  await env.OAUTH_KV.delete(`pending:${requestToken}`);

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: connection.userId,
    metadata: { agentName: connection.agentName, businessProfileCount: connection.businessProfileCount },
    scope: oauthRequest.scope?.length ? oauthRequest.scope : [],
    props: { mcpTokenHash: connection.tokenHash },
  });

  return Response.redirect(redirectTo, 302);
}

async function handleRegisterClient(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("x-admin-secret") || "";
  if (secret !== env.MCP_ADMIN_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  let body: { clientId?: string; clientName?: string; redirectUris?: string[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (!body.clientId || !body.clientName || !Array.isArray(body.redirectUris) || body.redirectUris.length === 0) {
    return new Response(JSON.stringify({ error: "clientId, clientName, redirectUris[] are required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const client = await env.OAUTH_PROVIDER.createClient({
    clientId: body.clientId,
    clientName: body.clientName,
    redirectUris: body.redirectUris,
    tokenEndpointAuthMethod: "none", // public client - MCP clients (CLIs/desktop apps) can't hold a secret
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  return new Response(JSON.stringify(client), { status: 200, headers: { "content-type": "application/json" } });
}

export const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/authorize") return handleAuthorize(request, env);
    if (request.method === "GET" && url.pathname === "/authorize/complete") return handleAuthorizeComplete(request, env);
    if (request.method === "POST" && url.pathname === "/admin/register-client") return handleRegisterClient(request, env);
    return new Response("Not found", { status: 404 });
  },
};
