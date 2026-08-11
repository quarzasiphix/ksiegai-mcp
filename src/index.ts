import { KsiegaiMcp } from "./mcp-agent";
import { resolveAccessToken } from "./auth";

export { KsiegaiMcp };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/mcp")) {
      return new Response("Not found", { status: 404 });
    }

    const props = await resolveAccessToken(request);
    if (!props) {
      return new Response(JSON.stringify({ error: "unauthorized", message: "Missing or malformed bearer token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    // McpAgent.serve()'s handler reads `ctx.props` off the ExecutionContext
    // and calls `agent.updateProps(ctx.props)` before dispatching to the
    // Durable Object — confirmed by reading node_modules/agents/dist/mcp
    // directly (undocumented as a plain-bearer pattern; it's the same hook
    // `workers-oauth-provider` uses, just set by hand here instead).
    (ctx as ExecutionContext & { props?: unknown }).props = props;

    return KsiegaiMcp.serve("/mcp", { binding: "KsiegaiMcp" }).fetch(request, env, ctx);
  },
};
