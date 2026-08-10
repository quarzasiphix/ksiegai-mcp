# ksiegai-mcp

MCP server exposing ksiegai accounting to AI agents (in-house and,
eventually, users' own AI assistants). Cloudflare Worker, deployed on its
own subdomain (`mcp.ksiegai.pl`), separate from `ksiegai-gateway` — see
"Why a separate Worker" below. Tracked as T-418 in
`ksef-ai/docs/todo/queue.md`.

## Architecture

```
MCP client (Claude, etc.)
  -> mcp.ksiegai.pl/mcp  (this Worker, KsiegaiMcp Durable Object)
  -> Service Binding "GATEWAY"  (worker-to-worker, no public hop)
  -> ksiegai-gateway  POST /v1/workspace
  -> ksef-ai's `ksiegai-workspace` edge function (action-dispatched)
  -> Postgres, RLS-scoped
```

This Worker never talks to Postgres or Supabase directly, and holds no
service-role key. It only holds (per-request) whatever bearer token the
caller supplies, and forwards it down the same chain the web app already
uses — RLS is still the real access-control boundary.

## Why a separate Worker (not a route on ksiegai-gateway)

- **Blast radius**: this is a new, external-facing surface for arbitrary AI
  agents. A bad deploy or bug here shouldn't be able to take down bank/
  invoice API traffic on the main gateway.
- **Transport shape**: MCP wants SSE/streamable-HTTP + session state, which
  doesn't fit gateway's plain REST routing.
- **Independent observability/rate-limits** for "AI agent traffic" vs
  normal app traffic.

Wired to `ksiegai-gateway` via a Cloudflare Service Binding (`env.GATEWAY`,
declared in `wrangler.jsonc`) so it reuses gateway's existing service/repo
layer instead of re-implementing anything.

## Auth — current state is Phase 0, not final

`src/auth.ts`'s `resolveAccessToken` currently accepts the caller's **real
ksiegai (Supabase) session token** as the MCP bearer token, 1:1 — same
trust model `ksiegai-gateway`'s own `requireSession` already uses for
legacy HS256 tokens (can't verify the signature without holding the shared
secret, so this only checks a token is present; gateway + Postgres RLS
enforce access downstream).

**This means an MCP client today gets the full scope of the user's own
session** — fine for a single trusted dev testing this end-to-end, **not**
safe to ship to real users. The planned real mechanism (not built yet, see
T-418): a `mcp_access_tokens` table + gateway-issued, business-scoped,
tiered (read-only / draft-write / full-post) opaque tokens that
`resolveAccessToken` looks up instead of accepting a raw session token.

## Props mechanism (how identity reaches tool handlers)

`McpAgent.serve(...).fetch(request, env, ctx)` reads `ctx.props` off the
`ExecutionContext` and calls `agent.updateProps(ctx.props)` before
dispatching to the Durable Object — confirmed by reading
`node_modules/agents/dist/mcp/index.js` directly (this is the same hook
`@cloudflare/workers-oauth-provider` uses; undocumented as a plain-bearer
pattern, so verify against that source again if the `agents` package
version bumps). `src/index.ts` sets `ctx.props` by hand after
`resolveAccessToken` succeeds, instead of going through a full OAuth
provider flow.

## Tools

- `get_chart_of_accounts(businessProfileId, activeOnly?)` — the only tool
  so far. Chosen as the first slice because `accounting.listChartAccounts`
  already exists end-to-end in the gateway/edge-function chain with zero
  new backend work, so it proves the whole path before any new tools (COA
  setup, journal posting, invoice/contract reads) get added.

## Local dev

```bash
npm install
npm run dev          # wrangler dev
npm run typecheck
npm run deploy:dry-run
```

Needs `ksiegai-gateway` reachable via the Service Binding — `wrangler dev`
resolves Service Bindings to the target Worker's own `wrangler dev`
instance if running locally, or its deployed version otherwise.

## Next steps (not built)

1. `mcp_access_tokens` + `mcp_audit_log` tables (business-scoped, tiered,
   revocable tokens; every tool call logged — required given accounting/
   legal stakes, see Tovernet compliance work in `ksef-ai`).
2. `resolveAccessToken` swapped to look up opaque tokens against that
   table (via a new gateway endpoint) instead of accepting raw session
   tokens.
3. Write tools: `draft_journal_entry` (always `entry_status='draft'`/
   `needs_review`, never auto-posts), `post_journal_entry` (separate,
   higher-trust call), `setup_chart_of_accounts`.
4. More read tools: `list_invoices`, `get_invoice`, `list_contracts`,
   `get_contract`, `get_posting_queue`, `get_account_balance`,
   `get_trial_balance` — each needs a corresponding `ksiegai-workspace`
   action if one doesn't already exist (most don't yet — only
   `accounting.listChartAccounts` is live today).
