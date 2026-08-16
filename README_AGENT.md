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

**Not yet built/exposed** (genuine gaps): contract reads,
`post-bank-transaction-rc` (the reverse-charge posting variant — only the
plain one has a tool so far), `setup_chart_of_accounts`.

## Pass 2 (2026-08-15): 8 new tools — T-418 continuation

Plan approved same day (accounting expansion: posting queue, period
report/ledger, bank transaction CRUD gaps, manual journal entries), built
in that order:

- `get_posting_queue` — every unposted/needs-review invoice/contract/
  loan-repayment/bank-transaction/Stripe-settlement, with a suggested
  posting template each. Wraps new `accounting.getPostingQueue` (ports
  `postingQueueRepository.ts`'s read side, two documented simplifications
  — see that route file's header).
- `get_period_report` — real P&L for one month (revenue/expense totals,
  net result, per-account breakdown). Wraps new `accounting.getPeriodReport`
  — built from `get_account_balances`'s `month_delta`, NOT a port of the
  frontend's `ProfitLoss.tsx`, which uses fixed made-up percentage splits
  rather than real per-account data.
- `list_journal_entries` — the general ledger (`journal_entries_with_lines`
  view), filterable by status/date range/source_type. Wraps new
  `accounting.listJournalEntries`.
- `update_bank_transaction` / `delete_bank_transaction` — the CRUD gap:
  bank accounts already had full CRUD, transactions only had list/import/
  classify/post, no way to fix a bad import's own fields or remove a
  duplicate. New `bank-api` actions `update-transaction`/`delete-transaction`,
  both rejected once a transaction's status is `posted`/`reconciled` (delete
  also backstopped by the existing `trg_prevent_posted_bank_tx_delete`
  trigger). draft_write tier.
- `draft_journal_entry` — manual journal entry (debits/credits validated to
  balance within 0.01), for anything not covered by a bank transaction or
  invoice. Wraps new `accounting.createJournalEntry` (ports
  `journalRepository.ts`'s `createJournalEntry()` — same
  `rpc_create_journal_entry`+`rpc_insert_journal_lines` sequence, same
  rollback-on-line-failure). **Always** `entry_status='draft'`, same
  never-auto-post posture as `add_expense_invoice`. draft_write tier.
- `preview_journal_entry_posting` / `post_journal_entry` — same
  confirm-before-post gate as `preview_bank_transaction_posting`/
  `post_bank_transaction`, generalized to a second Durable-Object SQLite
  table (`journal_posting_previews`, keyed on `journal_entry_id` alone).
  Wraps new `accounting.postJournalEntry` (thin wrapper on
  `rpc_post_journal_entry`, remaps its draft-only ERRCODE 22000 to a clean
  409). full_post tier for the post half, draft_write for the preview half.

**Not yet live-tested end-to-end** — mid-session, local Supabase's docker
volume was found to have only 2 migrations applied (`20260422*`) against
~150 files on disk through `20260815`; `bank_transactions` locally was
missing `status`/`counterparty_name`/`counterparty_iban` entirely as a
result. User is rehearsing the local DB separately; run the same live-test
method as the Pass 1 tools (below) once that's done, then update this note.

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

## Prompts

Distinct MCP primitive from tools — a named, reusable workflow template a
client can surface directly (e.g. as a slash command in Claude Desktop),
registered via `McpServer.registerPrompt` (SDK 1.30.0+). Returns a
`messages` array injected into the conversation for the model to act on
with its own tools — the server itself never sees the document.

- `add_expense_from_document(businessProfileId?)` — walks the model
  through reading an already-attached receipt/invoice image/PDF (model's
  own vision, no server-side OCR) and calling `add_expense_invoice` with
  the extracted fields. Exists because that tool's own description can't
  carry this much step-by-step guidance (which fields to extract, don't
  fabricate missing ones, mention the extracted supplier/total back to the
  user) without bloating every `tools/list` response. Same
  never-auto-post posture as the tool it wraps.

## OAuth auto-connect (2026-08-15)

Real OAuth 2.1 authorization-code flow (`@cloudflare/workers-oauth-provider`,
`src/index.ts` + `src/oauth.ts`) sitting *alongside*, not replacing, the
manual `mcp_...` token flow above — an MCP client can now click "connect",
have a browser open, log in / approve, and be connected automatically,
instead of copy-pasting a token from Ustawienia. Pre-registered clients
only (Claude Code, Claude Desktop, Codex) — no dynamic/self-service client
registration.

**Key design point**: OAuth is just another way to arrive at an
`mcp_access_tokens` row — `completeAuthorization`'s `props` is
`{ mcpTokenHash }`, the exact same shape the manual flow already produces.
Every downstream piece (`mcp-agent.ts`, `gateway-client.ts`,
`authenticateMcpCall`, the tier-check/audit-log system) is **completely
unchanged** — this was the whole point of the design, see the migration
`20260811120000_mcp_access_tokens.sql`'s own header comment, which
predicted exactly this.

```
1. MCP client -> GET mcp.ksiegai.pl/authorize?client_id=...&redirect_uri=...
2. src/oauth.ts's handleAuthorize: parseAuthRequest -> stash it in OAUTH_KV
   under a random requestToken (10 min TTL) -> 302 to ksef-ai's
   /settings/ai-mcp/authorize?requestToken=...&client=...
3. McpAuthorize.tsx (ksef-ai) - login via the app's normal route guard if
   needed, then the same business/tier/expiry picker McpConnect.tsx has -
   on approve calls mcp.createConnection (now accepts an optional
   oauthRequestToken) then does a plain top-level redirect to
   mcp.ksiegai.pl/authorize/complete?requestToken=...
4. src/oauth.ts's handleAuthorizeComplete: calls public-api's
   mcp.resolveOAuthConnection (via the gateway, dedicated route, same
   pattern as mcp.authenticate) with {requestToken} - that action
   atomically claims the matching mcp_access_tokens row (single-use: it
   nulls oauth_request_token on claim) and returns {tokenHash, userId,
   businessProfileId, permissionTier}. Looks up the pending AuthRequest
   from OAUTH_KV, calls completeAuthorization({request, userId,
   props: {mcpTokenHash: tokenHash}, scope}) -> redirects to the MCP
   client's own redirect_uri with a real code.
5. Client exchanges the code at mcp.ksiegai.pl/oauth/token (library-
   handled) for an access+refresh token. Every future /mcp call: the
   library validates it, sets ctx.props = {mcpTokenHash}, calls the same
   apiHandler as the manual path -> authenticateMcpCall's normal live
   revocation/tier/audit check runs exactly as before.
```

`src/index.ts` branches on the bearer token BEFORE touching
`OAuthProvider`: a `Bearer mcp_...` header takes the untouched legacy
path (byte-for-byte the same code as before this pass); anything else
(no token, or a real OAuth token) goes through `oauthProvider.fetch`,
which owns `/authorize`, `/oauth/token`, and OAuth-token-validated `/mcp`
calls.

**No shared secret between this Worker and public-api** for the
`/authorize/complete` -> `mcp.resolveOAuthConnection` hop — protection is
the `requestToken`'s own entropy (32 random bytes) + single-use (claimed
atomically, `oauth_request_token` nulled) + short TTL (10 min in
`OAUTH_KV`), the same protection class as an OAuth authorization code
itself. See that action's own header comment in ksef-ai's `mcp.actions.ts`
for the full reasoning.

**Client pre-registration**: `POST /admin/register-client`
(`x-admin-secret: <MCP_ADMIN_SECRET>` header, gated by a Worker secret) ->
calls `env.OAUTH_PROVIDER.createClient({clientId, clientName, redirectUris,
tokenEndpointAuthMethod: 'none', grantTypes: [...]})`. Run once per client
after deploy.

**Not yet live-tested end-to-end** (same local-DB-rehearsal block as the
accounting tools above) and **not deployable as-is**:
`wrangler.jsonc`'s `OAUTH_KV` namespace id is a placeholder
(`REPLACE_WITH_REAL_KV_NAMESPACE_ID`) — run
`wrangler kv namespace create ksiegai-mcp-oauth-kv` and put the real id in
before deploying. `wrangler deploy --dry-run` couldn't be verified in this
dev environment either (hangs, apparently on Cloudflare auth needed to
resolve/validate the KV namespace reference) — `tsc --noEmit` is clean and
the code was reviewed line-by-line against `workers-oauth-provider`'s
actual shipped `.d.ts` (not just its README, which was missing/wrong on a
few signatures), but this hasn't been bundle-verified the way Pass 1/2's
tools were.

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
2. ~~OAuth auto-connect~~ — built 2026-08-15, see "OAuth auto-connect"
   section below. **Not yet live-tested** (same local-DB-rehearsal block
   as Pass 2's tools) and needs a real `OAUTH_KV` namespace + pre-registered
   clients before it does anything in a real deploy — see that section.
3. ~~Write tools: `draft_journal_entry`, `post_journal_entry`~~ — done
   2026-08-15, see "Pass 2" above. `setup_chart_of_accounts` still not
   built.
4. ~~More read tools: `get_posting_queue`~~ — done 2026-08-15. Still not
   built: `get_contract`/`list_contracts` (no corresponding
   `ksiegai-workspace` action exists yet).
