// `wrangler types` only knows about `vars`/bindings declared in
// wrangler.jsonc — secrets (`wrangler secret put`, or `.dev.vars` locally)
// aren't declared there, so the generated `Env` in worker-configuration.d.ts
// doesn't include them. This augments that same global `Env` interface via
// normal TS declaration merging (same pattern as
// ksiegai-gateway/src/types/env-secrets.d.ts).

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export {};

declare global {
  interface Env {
    /** Gates POST /admin/register-client (pre-registering an OAuth client
     * like Claude Code/Claude Desktop) — set via `wrangler secret put`. */
    MCP_ADMIN_SECRET: string;
    /** Injected at runtime by the OAuthProvider instance wrapping this
     * Worker (src/index.ts) — not declared in wrangler.jsonc, hence the
     * manual declaration merge here rather than `wrangler types` picking
     * it up. Available inside defaultHandler/apiHandler only. */
    OAUTH_PROVIDER: OAuthHelpers;
  }
}
