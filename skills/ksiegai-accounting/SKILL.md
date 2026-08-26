---
name: ksiegai-accounting
description: "Use whenever an MCP connection to KsięgaI (ksiegai) is active or being set up — a Polish accounting SaaS. Covers the full tool catalog (66 tools, 11 categories: company/invoices/documents/accounting/posting queue/bank/team/governance-uchwały/contracts/compliance checklist/Stripe), the read_only/draft_write/full_post permission tiers, the mandatory preview-then-post confirmation pattern before anything is written to the ledger, common multi-tool workflows, and — important — how new and unproven large parts of this integration still are. Load this before calling ksiegai tools for the first time in a session, or whenever asked to reconcile Stripe, post a bank transaction or journal entry, check KSH compliance for a loan/contract, or review a company's compliance checklist."
---

# KsięgaI accounting (MCP)

KsięgaI is a Polish accounting SaaS (JDG sole proprietorships and sp. z o.o./S.A.
companies). This MCP server lets you read and, within limits, write a
connected business's accounting data — invoices, chart of accounts, journal
entries, bank transactions, corporate governance (uchwały/decisions), any
contract type, compliance checklist tasks, and Stripe reconciliation. Full
per-category tool reference (all 66 tools, descriptions, tiers): https://www.ksiegai.pl/mcp

## Read this first: how mature is this, actually

Be honest with the user about this, don't imply more confidence than the
tools deserve. Most of this tool surface — governance/KSH, contracts,
compliance checklist, Stripe reconciliation, and several of the accounting
tools — was built in one continuous push and is **freshly wired, not
battle-tested in production use**. Concretely:

- **Real bugs were found and fixed WHILE building this**, not before: three
  separate database functions had zero caller-membership checks (would have
  let any authenticated user act on a business they don't belong to) until
  patched; a dual-write mirror table was silently out of sync with its real
  table since 2026-08-15, breaking every write to checklist tasks until
  fixed; one router file had a JSDoc comment that accidentally closed itself
  early and crashed the whole `billing` function at boot. None of this was
  caught by review before someone actually exercised the code path. Treat
  a clean-looking response from a rarely-used tool with a little more
  skepticism than one from a heavily-used one (see maturity tiers below).
- **`check_ksh_compliance_for_loan`** wraps a real, previously **orphaned**
  compliance function (art. 15/210/230 KSH) — it existed with zero callers
  anywhere in the app before this MCP tool. The logic is real but has never
  been exercised by a real user in production.
- **KSH art. 210 §1 enforcement is inconsistent across the app.** The
  human-facing UI only blocks `lending_for_use` contracts without a proxy
  resolution — every other contract type involving a board member
  (`board_member`, `management_board`, `loan_shareholder`, etc.) has no
  UI-level block at all. `create_contract` sidesteps this by always forcing
  the contract to `draft`, and there is **no `activate_contract` tool** —
  nothing in this MCP surface can actually promote a contract past draft.
  Don't tell a user a contract is "authorized" just because it was created;
  a human still has to activate it in the app, and should check
  `check_ksh_compliance_for_loan`/`get_authority_chain` first if a board
  member is involved.
- **Tax formulas are real but have known soft spots**: the liniowy
  health-premium deduction cap is an estimate pending an official
  2026 figure, not a confirmed constant. `default_ryczalt_rate` is unset for
  most onboarded users, so ryczałt estimates commonly fall back to a generic
  17% with a warning — always surface that warning to the user rather than
  quoting the number as fact. The solidarity levy (danina solidarnościowa)
  calculation is explicitly simplified.
- **The two Stripe "pull from live API" tools** (`import_stripe_fees`,
  `import_stripe_payouts`) have only been verified for routing/auth/error
  handling, never a real successful round-trip against Stripe's API in this
  environment. They call the same code the app's own UI uses, so they
  should work, but say so if a user asks "has this been tested."
- **A previously-designed "ledger branches" feature (draft-batch-before-merge
  for journal entries) does not exist** — it was scoped but deliberately not
  built. Don't imply batched draft/review/merge is available; each journal
  entry is drafted and posted individually.
- Known, logged-but-unfixed issues: `shareholder_loans.linked_decision_id`
  has a foreign key pointing at a different table than the one
  `check_ksh_compliance_for_loan` actually queries by that id (so an art. 15
  consent linked via that column may not be detected — don't assume
  art15_satisfied is reliable if the loan has a `linked_decision_id` set but
  the check still reports it missing); some other dual-write mirror tables
  besides the checklist one may have similar undetected schema drift.

**What IS comparatively solid**: chart-of-accounts CRUD, journal entry
draft/preview/post, bank statement import/classify/post, invoice
listing/expense creation, company documents, and team management — these
are the oldest, most-exercised parts of the tool surface. Lean on those with
more confidence than the newer categories above.

When in doubt: say what you did, cite which tool gave you the number, and
suggest the user double-check anything with real legal or tax consequences
(KSH compliance, tax estimates, VAT status) with their accountant — this
tool surface assists bookkeeping, it does not replace professional review.

## The permission model — always assume the lowest tier until told otherwise

Every MCP connection has one of three tiers, set by the user when they
create the connection:

- **read_only** — every `list_*`/`get_*` tool. No writes possible at all.
- **draft_write** — adds tools that create or edit DRAFT state (journal
  entries, contracts, decisions, resolutions, bank transaction imports,
  chart-of-accounts edits, Stripe imports/links). **Nothing at this tier
  ever becomes a permanent, posted accounting record** — everything lands
  as `draft`/`needs_review`/unposted, by design, regardless of what you pass
  as input. `pause_decision` is here too (freezing an authorization is the
  safe/conservative direction).
- **full_post** — adds the handful of tools that make a real, hard-to-reverse
  write: `post_journal_entry`, `post_bank_transaction`, `resume_decision`
  (restoring a paused authorization is the risk-increasing direction, so it
  needs the higher tier even though pausing doesn't).

If a tool call fails with a permission/tier error, don't retry with a
workaround — tell the user their connection doesn't have that permission
level and they'd need to grant it in ksiegai (Ustawienia → Połącz AI (MCP)).

## The preview-then-post pattern — never skip the confirmation step

`draft_journal_entry`/`post_journal_entry` and their bank-transaction
equivalents (`preview_bank_transaction_posting`/`post_bank_transaction`)
share one safety mechanic: posting requires a matching preview call for the
exact same entity, made within the last 15 minutes, from the SAME connection.

The correct sequence, every time:
1. Draft or identify the thing to post (`draft_journal_entry`, or find a
   bank transaction / Stripe settlement via `get_posting_queue`).
2. Call the matching `preview_*` tool. Show the user exactly what it says —
   accounts, amounts, direction.
3. **Wait for the user's explicit go-ahead.** Never chain preview straight
   into post on your own initiative, even if the preview looks obviously
   correct.
4. Only then call the matching `post_*` tool.

`create_resolution`/`create_decision`/`create_contract` don't need a preview
step because they can never post anything themselves (see draft_write
above) — but still don't create a `article_210_proxy_appointment` resolution
or a board-member contract without the user understanding why (KSH
compliance), since these have real legal weight once a human later acts on
them in the app.

## Tool categories (see /mcp on the marketing site for every tool + full description)

| Category | What it's for |
|---|---|
| Firma | Discover which business profile(s) this connection covers — call `list_business_profiles` first, always |
| Faktury | Read invoices, add expense invoices (always lands `needs_review`) |
| Dokumenty | Company documents — contracts, resolutions, licenses, filings |
| Księgowość | Chart of accounts CRUD, balances, journal entries |
| Kolejka i raporty | `get_posting_queue` (everything needing accounting attention, with ready posting templates), P&L, general ledger |
| Bank | Accounts, transactions (filterable by date/status/classification/direction), import, classify, post |
| Zespół | Team members and invitations |
| Uchwały i decyzje | Resolutions (uchwały), decisions/mandates, KSH art. 210 §1 compliance checking, pause/resume authorizations |
| Umowy | Contracts of any type — always created as inert drafts |
| Zgodność | Compliance checklist (CRBR, e-Doręczenia, KSeF activation, etc.) |
| Stripe | Pull fee/payout data from Stripe's live API, browse reconciliation, match payouts to bank transactions and invoices, close the posting loop |

## Common workflows

**"What does this company still need to do?"** → `list_checklist_tasks`
(filter `status=todo` client-side if needed) for formal/compliance
obligations; `get_posting_queue` for accounting-specific backlog.

**Post a bank transaction** → `list_bank_accounts` → `list_bank_transactions`
(narrow with `startDate`/`endDate`/`status=needs_review`) → `classify_bank_transaction`
→ `preview_bank_transaction_posting` → show the user → confirm →
`post_bank_transaction`.

**Reconcile a month of Stripe activity** → `list_payment_provider_accounts`
to get the account id → `import_stripe_fees` + `import_stripe_payouts` for
the month → `get_stripe_period_settlement` to see the totals →
`get_posting_queue` for the ready-made sale/fee posting templates →
`draft_journal_entry` + preview + confirm + `post_journal_entry` for each
leg → `link_stripe_settlement_journal_entry` (or
`link_stripe_fee_summary_journal_entry`) so it stops reappearing in the
queue. For the bank side: `match_stripe_payout_to_bank_transaction` to
auto-link payouts to statement lines within the amount/±4-day window.

**Check a shareholder loan before treating it as authorized** →
`check_ksh_compliance_for_loan` (art. 15/210/230, all at once) →
`get_authority_chain` if you also need the broader mandate/decision chain
for a related contract or invoice → if art. 210 is unsatisfied,
`create_resolution` with `resolutionType='article_210_proxy_appointment'`
is the fix, but that only creates a DRAFT uchwała — a human still has to run
the real vote in the app.

**Suspect a decision shouldn't be authorizing things right now** →
`pause_decision` with a reason (safe, reversible, low tier) → tell the
user what you paused and why → they (or you, with `full_post` tier and
their explicit confirmation) call `resume_decision` once it's resolved.

## Setting up a brand-new business profile for accounting

`setup_chart_of_accounts` before anything else (idempotent — safe to call
even if unsure whether it's already been done). Then chart-of-accounts CRUD,
then normal posting-queue work.
