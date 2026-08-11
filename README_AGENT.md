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

## Auth — Phase 1, real per-connection tokens (2026-08-11)

`src/auth.ts`'s `resolveAccessToken` accepts an opaque `mcp_...` token
(64 hex chars, 32 random bytes), issued per-connection from ksiegai's
Settings -> "Połącz AI (MCP)" screen (`McpConnect.tsx` in the `ksef-ai`
repo). It's hashed (SHA-256) immediately, before it ever reaches the
Durable Object — only the hash lives in `McpProps`/`this.props`.

Every tool call re-exchanges that hash for a short-lived (10 min) real
Supabase session JWT via `gateway-client.ts`'s `authenticateMcpCall`,
which calls `ksiegai-gateway`'s dedicated `POST /v1/public/mcp/authenticate`
route -> `ksef-ai`'s `public-api` edge function's `mcp.authenticate`
action. That action (service-role, `verify_jwt=false`):

- looks up the token by hash in `mcp_access_tokens` (business_profile_id,
  created_by, permission_tier, expires_at, revoked_at)
- rejects if revoked/expired (checked FRESH every call — a revoked
  connection stops working on its very next tool call, not just at
  reconnect)
- rejects if the tool's declared `businessProfileId` doesn't match the
  token's bound one — this is the actual access boundary for
  "connection scoped to one business," since Postgres RLS itself has no
  concept of it (RLS is `auth.uid()` -> membership lookup only, spans ALL
  of a user's businesses; see `mcp_access_tokens` migration's header)
- rejects if the tool isn't allowed under the token's tier
  (read_only / draft_write / full_post — see `mcp.actions.ts`'s
  `TIER_ALLOWED_TOOLS` for the exact map)
- writes an `mcp_audit_log` row for every outcome, updates `last_used_at`
- mints the JWT via `jose`'s `SignJWT` (HS256, signed with
  `MCP_SESSION_JWT_SECRET` — a Supabase Edge Function secret holding this
  project's legacy JWT secret; **not** named `SUPABASE_JWT_SECRET` because
  the Supabase CLI reserves that prefix and silently drops such vars from
  `--env-file`/`secrets set`, confirmed 2026-08-11)

This Worker never holds that JWT secret — only `public-api` does. Known
limitation (documented in the migration, not fixed): `mcp.authenticate`
checks the *declared* `businessProfileId` matches the token, but doesn't
verify a given `accountId`/`bankTransactionId` actually belongs to it —
exploiting that needs already knowing another business's internal IDs.

`list_business_profiles` is a special case (see its own comment in
`mcp-agent.ts`): it has no `businessProfileId` to declare (its job is to
reveal one), so it exchanges bare and filters `core.init`'s result down to
just `authorizedBusinessProfileId`.

Not built yet: the OAuth auto-connect flow (browser auto-opens to an
in-app authorize screen when a client connects with no token) — deferred
by the user 2026-08-11 as a separate future pass. This foundation is
already compatible with it: OAuth would just be a different way to arrive
at a `mcp_access_tokens` row, reusing this exact exchange/tier/audit path.

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

- `list_business_profiles()` — every business profile (JDG, sp. z o.o.,
  etc) the caller has access to: id, name, entity type, tax regime,
  VAT-exempt status. Zero new backend work — wraps `core.init`, trimmed to
  the fields an accounting tool caller needs. Call this first to discover
  which `businessProfileId` to use everywhere else.
- `get_chart_of_accounts(businessProfileId, activeOnly?)` — wraps
  `accounting.listChartAccounts`, also zero new backend work.
- `add_expense_invoice(businessProfileId, supplierName, issueDate, items[], ...)`
  — records a cost/expense invoice. The calling AI does its own
  reading/extraction (email, receipt image, whatever) and passes already-
  structured fields; this tool does no OCR. Wraps a **new** ksef-ai edge-
  function action, `invoices.createExpense`
  (`ksef-ai/supabase/functions/ksiegai-workspace/domains/invoices/routes/createExpense.route.ts`)
  — ports the expense half of the frontend's `saveInvoice()`: resolves/
  creates the supplier as a `customers` row, normalizes VAT per line
  (matches `saveInvoice`'s exempt-sentinel/net-vat-gross logic exactly),
  writes via the same `rpc_save_invoice` RPC the app itself uses.
  **Always** forces `posting_status`/`accounting_status='needs_review'`,
  `acceptance_status='pending'`, `invoice_source='mcp_agent'` — never
  auto-posts or auto-accepts, regardless of what the caller sends; a human
  reviews it in the normal expense/posting queue. `invoice_source`'s CHECK
  constraint was widened locally (not yet a migration) to allow
  `'mcp_agent'` alongside the existing `manual`/`ksef`/`import`/`api`.
  Deployed to production 2026-08-10 (migration + edge function). Also
  reachable as `invoices.save` (thin proxy, no logic duplicated) for the
  ksef-ai frontend's own `saveInvoice()` — see `ksiegai-workspace/README_AGENT.md`'s
  "Pass 3" section.
- `get_balance_sheet(businessProfileId, asOfDate?, periodYear?, periodMonth?)`
  — per-account current/month/YTD balances (posted entries only), the raw
  data behind the balance sheet / trial balance. Wraps **new**
  `accounting.getAccountBalances`, added specifically because
  `public.get_account_balances` (the underlying RPC) is `SECURITY DEFINER`
  with **no membership check inside it at all** — confirmed by reading the
  function body. The route adds an explicit check (RLS-scoped SELECT on
  `business_profiles`, whose own SELECT policy already does real
  `is_company_member()` scoping) before calling the RPC, since
  `_assert_bp_member` can't be called directly from an edge function
  (`REVOKE EXECUTE FROM authenticated`).
- `list_invoices(businessProfileId, startDate?, endDate?)` — wraps the
  already-existing `invoices.listInvoices`, zero new backend work.
- `list_bank_accounts(businessProfileId)` / `list_bank_transactions(accountId)`
  — wrap bank-api's already-existing `list-accounts`/`list-transactions`
  (a *different* edge function than `ksiegai-workspace`, reached via the
  gateway's separate `/v1/banking` proxy — see `callBanking` in
  `gateway-client.ts`). Zero new backend work.
- `import_bank_statement(businessProfileId, bankAccountId, fileName, transactions[])`
  — the calling AI reads a statement itself (PDF/CSV/screenshot/whatever)
  and passes already-structured rows; no OCR/parsing here. Wraps
  bank-api's existing `import-bank-statement`, which itself already only
  accepts pre-parsed rows (never raw file bytes) — this route was already
  MCP-shaped before any of tonight's work. Lands every transaction as
  `status='imported'` — nothing classified or posted. `file_format` is
  hardcoded to `'mcp_agent'` (see bugs below — that value didn't exist
  until tonight).
- `classify_bank_transaction(bankTransactionId, classification, notes?)` —
  wraps bank-api's `classify-bank-transaction`. Forces `status='needs_review'`
  always, ignoring anything else the caller might try to pass — matches
  that route's own default, made explicit here.
- `preview_bank_transaction_posting(accountId, bankTransactionId, creditAccountId)`
  and `post_bank_transaction(bankTransactionId, creditAccountId)` — the
  approval-gated posting pair. `post_bank_transaction` calls bank-api's
  `post-bank-transaction`, which posts a REAL, immediate journal entry with
  no review step of its own (confirmed by reading the route — unlike
  `add_expense_invoice`'s `needs_review` posture, this one is instant).
  Since an ungated write tool here would let an AI post to the ledger with
  zero human check, `post_bank_transaction` **requires** a matching
  `preview_bank_transaction_posting` call for the exact same
  `bankTransactionId`+`creditAccountId` pair within the last 15 minutes —
  tracked in the Durable Object's own SQLite storage (`this.sql`, no new
  external infra), one-time-use (deleted on successful post). The preview
  tool's description explicitly instructs the calling AI to show the
  briefing to the user and get explicit confirmation before calling post —
  enforced by the token requirement, not just a polite suggestion in the
  text. `post_bank_transaction`'s success response is itself the
  "briefing" the user asked for (accounts, amounts, journal entry id).

All 11 tools verified live 2026-08-10 against local Supabase over the real
MCP protocol (streamable-HTTP `initialize` → `tools/list` → `tools/call`,
not just DB simulation): both `wrangler dev` processes (gateway on 8787,
this Worker on 8788) running together with the Service Binding actually
`[connected]` (needs both started as real `wrangler dev` sessions - a
stray/older gateway process that predated this session didn't register in
`~/.wrangler/registry` and had to be killed/restarted), a locally-forged
HS256 JWT (local Supabase's well-known dev `JWT_SECRET`) as the bearer
token, real Tovernet data. The banking flow was tested end to end: import
→ classify → **post attempted without preview (correctly rejected)** →
preview → post (succeeded, real journal entry, verified directly against
`journal_lines`) → **post retried immediately (correctly rejected, token
already consumed)**. All test rows (bank transaction, import batch,
journal entry/lines, and earlier the expense invoice + its supplier
customer) deleted afterward to keep Tovernet's real data clean.

**Not yet built/exposed** (genuine gaps, not tested because they don't
exist): `draft_journal_entry`/`post_journal_entry` for manual (non-bank-
transaction) journal entries from the original design, `get_posting_queue`
(posting queue is still a direct multi-table client-side aggregation, not
ported to `ksiegai-workspace` yet), contract reads, `post-bank-transaction-rc`
(the reverse-charge posting variant — only the plain one has a tool so far).

**Bugs found and fixed during this same live-test pass** (not caught by
`tsc --noEmit`, only by actually calling the tools):
- `wrangler.jsonc`'s `compatibility_date` was newer than the locally
  installed `workerd` binary supports — dropped to a supported date.
- `gateway-client.ts`'s `callWorkspace` returned the gateway's full
  `{data, meta}` envelope unwrapped. `get_chart_of_accounts` looked fine
  (just forwards raw text to the caller either way), but
  `list_business_profiles` silently returned `[]` — it was reading
  `.businessProfiles` off the envelope instead of `.data.businessProfiles`.
  Fixed to unwrap `.data`, matching the frontend's own
  `callGatewayWorkspace` convention (`return body.data as T`).
- `banking.bank_import_batches.file_format`'s CHECK constraint had no value
  for "AI-interpreted, not a real parsed export format" — same class of
  issue as `invoices.invoice_source` above. Widened to add `'mcp_agent'`
  (`ksef-ai/supabase/migrations/20260810130000_bank_import_batches_mcp_agent_format.sql`).
  `import_bank_statement` no longer even exposes `fileFormat` as an input —
  hardcoded to `'mcp_agent'` server-side, since the tool's whole premise is
  "AI read this, didn't parse a real file."
- Not a bug in this repo, but found while live-testing `post_bank_transaction`:
  bank-api's own `postBankTransaction()` hardcodes `amountMinor: 0` in its
  return value (the actual posted journal entry is correct — verified
  directly against `journal_lines` — only the response payload is wrong).
  Documented, not fixed, in `ksef-ai/supabase/functions/bank-api/README_AGENT.md`.

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

1. ~~`mcp_access_tokens` + `mcp_audit_log` tables~~ — done 2026-08-11, see
   "Auth — Phase 1" above.
2. OAuth auto-connect (browser auto-opens to an in-app authorize screen on
   first connect, zero copy-paste) — deferred by the user 2026-08-11,
   compatible with the Phase 1 foundation (see that section's last
   paragraph). Would need `@cloudflare/workers-oauth-provider` + a new
   `OAUTH_KV` namespace, restructuring `src/index.ts`'s flat fetch handler.
3. Write tools: `draft_journal_entry` (always `entry_status='draft'`/
   `needs_review`, never auto-posts), `post_journal_entry` (separate,
   higher-trust call), `setup_chart_of_accounts`.
4. More read tools: `list_invoices`, `get_invoice`, `list_contracts`,
   `get_contract`, `get_posting_queue`, `get_account_balance`,
   `get_trial_balance` — each needs a corresponding `ksiegai-workspace`
   action if one doesn't already exist (most don't yet — only
   `accounting.listChartAccounts` is live today).
