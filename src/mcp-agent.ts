import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { McpProps } from "./auth";
import { callWorkspace, callBanking, authenticateMcpCall, McpAuthError } from "./gateway-client";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PREVIEW_TTL_MS = 15 * 60 * 1000;

function authErrorResult(error: McpAuthError): ToolResult {
  const text =
    error.status === 401
      ? "This MCP connection's token is invalid, expired, or has been revoked. Ask the user to create a new " +
        "connection in ksiegai -> Ustawienia -> Połącz AI (MCP)."
      : error.status === 403
        ? `This connection is not authorized for that: ${error.message}`
        : `Authentication failed: ${error.message}`;
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * First real tools, chosen deliberately for zero new backend work — both
 * already exist end-to-end (gateway -> ksiegai-workspace -> RLS-scoped
 * Postgres) and just needed wiring here, proving the whole chain — MCP tool
 * -> this Worker -> Service Binding -> gateway -> edge function -> RLS —
 * before any new read/write actions get built to expand the tool list.
 */
export class KsiegaiMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: "ksiegai-accounting", version: "0.1.0" });

  /**
   * Every tool call exchanges the connection's opaque-token hash for a
   * short-lived real session JWT FIRST (see gateway-client.ts's
   * authenticateMcpCall) — this is what enforces live revocation,
   * per-tool tier scoping, and business-profile scoping, since none of
   * that lives in the JWT itself or in Postgres RLS. `businessProfileId`
   * is required for every tool except list_business_profiles (see that
   * tool's own bespoke implementation below).
   */
  private async call(
    toolName: string,
    businessProfileId: string,
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    if (!this.props?.mcpTokenHash) {
      return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
    }
    try {
      const { accessToken } = await authenticateMcpCall(this.env, this.props.mcpTokenHash, toolName, businessProfileId);
      const result = await callWorkspace(this.env, accessToken, action, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof McpAuthError) return authErrorResult(err);
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  private async callBank(
    toolName: string,
    businessProfileId: string,
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    if (!this.props?.mcpTokenHash) {
      return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
    }
    try {
      const { accessToken } = await authenticateMcpCall(this.env, this.props.mcpTokenHash, toolName, businessProfileId);
      const result = await callBanking(this.env, accessToken, action, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof McpAuthError) return authErrorResult(err);
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  async init() {
    // Backs preview_bank_transaction_posting / post_bank_transaction's
    // confirm-before-you-post gate - see those tools below for why.
    this.sql`CREATE TABLE IF NOT EXISTS posting_previews (
      bank_transaction_id TEXT NOT NULL,
      credit_account_id TEXT NOT NULL,
      previewed_at INTEGER NOT NULL,
      PRIMARY KEY (bank_transaction_id, credit_account_id)
    )`;

    // Same confirm-before-post gate, for manual journal entries - see
    // preview_journal_entry_posting / post_journal_entry below.
    this.sql`CREATE TABLE IF NOT EXISTS journal_posting_previews (
      journal_entry_id TEXT NOT NULL PRIMARY KEY,
      previewed_at INTEGER NOT NULL
    )`;

    this.server.registerTool(
      "list_business_profiles",
      {
        description:
          "List the ksiegai business profile(s) this connection is authorized for (id, name, entity type, " +
          "tax regime, VAT-exempt status). A connection can cover one or more businesses, each with its own " +
          "permission tier (Ustawienia -> Połącz AI (MCP)) - call this first to get the businessProfileId(s), " +
          "required by every other tool. An empty result means no business has been granted to this " +
          "connection yet - tell the user to add one in Ustawienia -> Połącz AI (MCP) -> edit this connection.",
        inputSchema: {},
      },
      async () => {
        // Bespoke, not routed through this.call(): this is the one tool
        // that structurally has no businessProfileId to declare up front
        // (its whole job is to reveal them) - it exchanges for
        // authorizedBusinessProfileIds itself (T-418 multi-company,
        // 2026-08-17) and filters core.init's result down to just those
        // businesses, so a connection scoped to businesses A+B never leaks
        // the names/NIPs of the user's OTHER businesses even though the
        // underlying session JWT's RLS access spans all of them.
        if (!this.props?.mcpTokenHash) {
          return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
        }
        let accessToken: string;
        let authorizedBusinessProfileIds: string[];
        try {
          const exchanged = await authenticateMcpCall(this.env, this.props.mcpTokenHash, "list_business_profiles");
          accessToken = exchanged.accessToken;
          authorizedBusinessProfileIds = exchanged.authorizedBusinessProfileIds;
        } catch (err) {
          if (err instanceof McpAuthError) return authErrorResult(err);
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }

        let result: unknown;
        try {
          result = await callWorkspace(this.env, accessToken, "core.init");
        } catch (err) {
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }

        try {
          const authorizedIds = new Set(authorizedBusinessProfileIds);
          const parsed = result as { businessProfiles?: any[] };
          const profiles = (parsed.businessProfiles || [])
            .filter((p: any) => authorizedIds.has(p.id))
            .map((p: any) => ({
              businessProfileId: p.id,
              name: p.name,
              entityType: p.entity_type,
              taxType: p.tax_type,
              isVatExempt: p.is_vat_exempt,
              accessRole: p.access_role,
              nip: p.tax_id,
              regon: p.regon,
              krsNumber: p.krs_number,
            }));
          return { content: [{ type: "text", text: JSON.stringify(profiles) }] };
        } catch {
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
      },
    );

    this.server.registerTool(
      "get_chart_of_accounts",
      {
        description: "List the chart of accounts (COA) for this connection's business profile.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          activeOnly: z.boolean().optional(),
        },
      },
      async ({ businessProfileId, activeOnly }) =>
        this.call("get_chart_of_accounts", businessProfileId, "accounting.listChartAccounts", { businessProfileId, activeOnly }),
    );

    this.server.registerTool(
      "setup_chart_of_accounts",
      {
        description:
          "Set up the starter chart of accounts (28-row Polish COA) for a business profile that doesn't have " +
          "one yet, plus the account-key map (resolves semantic keys like BANK_MAIN/AR_CUSTOMERS/VAT_OUTPUT to " +
          "specific account codes) that other posting tools rely on. Safe to call defensively before drafting " +
          "journal entries for a new business - if a chart of accounts already exists, returns alreadyExists:true " +
          "instead of an error. Requires draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
        },
      },
      async ({ businessProfileId }) =>
        this.call("setup_chart_of_accounts", businessProfileId, "accounting.setupChartOfAccounts", { businessProfileId }),
    );

    const ACCOUNT_TYPE_ENUM = z.enum(["asset", "liability", "equity", "revenue", "expense", "off_balance"]);

    this.server.registerTool(
      "create_chart_account",
      {
        description:
          "Add a new account to this business profile's chart of accounts. Use setup_chart_of_accounts first if " +
          "the profile has no chart of accounts at all. Requires draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          code: z.string().describe("Account code, e.g. '410' - convention is 3-digit Polish COA codes, see get_chart_of_accounts for existing codes"),
          name: z.string(),
          accountType: ACCOUNT_TYPE_ENUM,
          parentId: z.string().uuid().optional().describe("Parent synthetic account, if this is a sub-account"),
          isSynthetic: z.boolean().optional().describe("True for a grouping/summary account, not directly posted to"),
          defaultVatRate: z.number().optional().describe("e.g. 23 for 23%"),
          vatExempt: z.boolean().optional(),
          description: z.string().optional(),
        },
      },
      async ({ businessProfileId, code, name, accountType, parentId, isSynthetic, defaultVatRate, vatExempt, description }) =>
        this.call("create_chart_account", businessProfileId, "accounting.createChartAccount", {
          businessProfileId, code, name, accountType, parentId, isSynthetic, defaultVatRate, vatExempt, description,
        }),
    );

    this.server.registerTool(
      "update_chart_account",
      {
        description:
          "Edit an existing chart-of-accounts entry (partial update - only pass fields you want to change). Also " +
          "used to reactivate a previously deactivated account (isActive: true). Requires draft_write or full_post " +
          "permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          chartAccountId: z.string().uuid(),
          code: z.string().optional(),
          name: z.string().optional(),
          accountType: ACCOUNT_TYPE_ENUM.optional(),
          parentId: z.string().uuid().optional(),
          isSynthetic: z.boolean().optional(),
          defaultVatRate: z.number().optional(),
          vatExempt: z.boolean().optional(),
          description: z.string().optional(),
          isActive: z.boolean().optional().describe("Set true to reactivate a deactivated account"),
        },
      },
      async ({ businessProfileId, chartAccountId, ...patch }) =>
        this.call("update_chart_account", businessProfileId, "accounting.updateChartAccount", {
          businessProfileId, chartAccountId, ...patch,
        }),
    );

    this.server.registerTool(
      "deactivate_chart_account",
      {
        description:
          "Soft-delete (deactivate) a chart-of-accounts entry - it stops appearing for new postings but its " +
          "historical postings are unaffected and it can be reactivated later via update_chart_account. Blocked " +
          "if the account is still referenced by any DRAFT (unposted) journal entry lines - resolve those first. " +
          "Requires draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          chartAccountId: z.string().uuid(),
          reason: z.string().optional(),
        },
      },
      async ({ businessProfileId, chartAccountId, reason }) =>
        this.call("deactivate_chart_account", businessProfileId, "accounting.deactivateChartAccount", {
          businessProfileId, chartAccountId, reason,
        }),
    );

    this.server.registerTool(
      "get_balance_sheet",
      {
        description:
          "Per-account balances (current, month-to-date change, year-to-date change) as of a given date - the " +
          "raw data behind the balance sheet / trial balance. Only includes posted journal entries. Cross-reference " +
          "with get_chart_of_accounts for account codes/names/types (asset/liability/equity/revenue/expense).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          asOfDate: z.string().optional().describe("ISO date, YYYY-MM-DD. Defaults to today."),
          periodYear: z.number().optional().describe("For the month-to-date column. Defaults to current year."),
          periodMonth: z.number().optional().describe("1-12, for the month-to-date column. Defaults to current month."),
        },
      },
      async ({ businessProfileId, asOfDate, periodYear, periodMonth }) =>
        this.call("get_balance_sheet", businessProfileId, "accounting.getAccountBalances", { businessProfileId, asOfDate, periodYear, periodMonth }),
    );

    this.server.registerTool(
      "get_posting_queue",
      {
        description:
          "The posting queue - every unposted/needs-review economic event for this business profile: invoices, " +
          "financing contracts (loans, capital contributions), shareholder loan repayments, bank transactions, " +
          "and Stripe period settlements, each with a suggested debit/credit posting template (chart-of-accounts " +
          "codes) and, for bank transactions, a possible match against an outstanding invoice. Read-only - use " +
          "this to see what still needs accounting attention, then classify_bank_transaction / " +
          "preview_bank_transaction_posting+post_bank_transaction / draft_journal_entry to actually act on an item.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          startDate: z.string().optional().describe("ISO date, YYYY-MM-DD"),
          endDate: z.string().optional().describe("ISO date, YYYY-MM-DD"),
        },
      },
      async ({ businessProfileId, startDate, endDate }) =>
        this.call("get_posting_queue", businessProfileId, "accounting.getPostingQueue", { businessProfileId, startDate, endDate }),
    );

    this.server.registerTool(
      "get_period_report",
      {
        description:
          "Real profit & loss for one calendar month - revenue total, expense total, net result, and a " +
          "per-account breakdown (code, name, type, current balance, this-period movement, year-to-date " +
          "movement), built from posted journal entries only. Cross-reference get_chart_of_accounts for full " +
          "account names/types if not returned inline.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          periodYear: z.number().optional().describe("Defaults to current year"),
          periodMonth: z.number().optional().describe("1-12, defaults to current month"),
        },
      },
      async ({ businessProfileId, periodYear, periodMonth }) =>
        this.call("get_period_report", businessProfileId, "accounting.getPeriodReport", { businessProfileId, periodYear, periodMonth }),
    );

    this.server.registerTool(
      "list_journal_entries",
      {
        description:
          "List journal entries (with their lines) for this business profile - the general ledger. Optionally " +
          "filter by status (draft/posted/void/reversed), date range, or source_type (e.g. invoice, bank_transaction, " +
          "manual). Use this to see the actual postings behind get_period_report's totals or get_balance_sheet's " +
          "balances.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          status: z.string().optional().describe("draft | posted | void | reversed"),
          startDate: z.string().optional().describe("ISO date, YYYY-MM-DD"),
          endDate: z.string().optional().describe("ISO date, YYYY-MM-DD"),
          sourceType: z.string().optional(),
          limit: z.number().optional(),
        },
      },
      async ({ businessProfileId, status, startDate, endDate, sourceType, limit }) =>
        this.call("list_journal_entries", businessProfileId, "accounting.listJournalEntries", { businessProfileId, status, startDate, endDate, sourceType, limit }),
    );

    const journalLineSchema = z.object({
      accountId: z.string().uuid().describe("From get_chart_of_accounts"),
      side: z.enum(["debit", "credit"]),
      amount: z.number().positive().describe("PLN, e.g. 123.45 - not minor units"),
      description: z.string().optional(),
      lineNumber: z.number().int().describe("1-based, unique within this entry"),
    });

    this.server.registerTool(
      "draft_journal_entry",
      {
        description:
          "Create a manual journal entry (debits/credits must balance to within 0.01) for something not covered " +
          "by a bank transaction or invoice - e.g. a correction, accrual, or depreciation entry. Requires " +
          "draft_write or full_post permission tier. ALWAYS created as entry_status='draft' - never auto-posted, " +
          "regardless of tier. Use preview_journal_entry_posting then post_journal_entry (with explicit user " +
          "confirmation) to actually post it to the ledger.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          entryDate: z.string().describe("ISO date, YYYY-MM-DD"),
          description: z.string(),
          referenceNumber: z.string().optional(),
          notes: z.string().optional(),
          lines: z.array(journalLineSchema).min(2).describe("At least one debit line and one credit line"),
        },
      },
      async ({ businessProfileId, entryDate, description, referenceNumber, notes, lines }) => {
        const payloadLines = lines.map((l) => ({
          account_id: l.accountId,
          side: l.side,
          amount: l.amount,
          description: l.description,
          line_number: l.lineNumber,
        }));
        return this.call("draft_journal_entry", businessProfileId, "accounting.createJournalEntry", {
          businessProfileId,
          entryDate,
          description,
          referenceNumber,
          notes,
          lines: payloadLines,
        });
      },
    );

    this.server.registerTool(
      "preview_journal_entry_posting",
      {
        description:
          "Dry-run preview of posting a draft journal entry - shows the entry and its lines, but posts NOTHING. " +
          "Required before post_journal_entry will succeed (same journalEntryId, within 15 minutes). Show this " +
          "briefing to the user and get their explicit go-ahead before calling post_journal_entry - never chain " +
          "straight from preview to post without the user confirming in between.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          journalEntryId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, journalEntryId }) => {
        const listResult = await this.call("preview_journal_entry_posting", businessProfileId, "accounting.listJournalEntries", { businessProfileId });
        if (listResult.isError) return listResult;
        let briefing: unknown = null;
        try {
          const parsed = JSON.parse(listResult.content[0].text) as { entries?: any[] };
          briefing = (parsed.entries || []).find((e) => e.id === journalEntryId) ?? null;
        } catch {
          // fall through with briefing = null
        }
        if (!briefing) {
          return { content: [{ type: "text", text: `Journal entry ${journalEntryId} not found.` }], isError: true };
        }
        this.sql`INSERT OR REPLACE INTO journal_posting_previews (journal_entry_id, previewed_at) VALUES (${journalEntryId}, ${Date.now()})`;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                previewOnly: true,
                nothingPosted: true,
                entry: briefing,
                instructions: "Show this to the user. Only call post_journal_entry after they explicitly confirm.",
              }),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "post_journal_entry",
      {
        description:
          "Post a draft journal entry to the ledger - a REAL, immediate write, not reversible via this tool. " +
          "Requires a connection with full_post permission tier, AND a matching preview_journal_entry_posting " +
          "call for the exact same journalEntryId within the last 15 minutes, AND the user has explicitly " +
          "confirmed after seeing that preview. Never call this speculatively or without the user's explicit " +
          "go-ahead. After posting, give the user a short briefing of exactly what was posted.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          journalEntryId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, journalEntryId }) => {
        const rows = this.sql<{ previewed_at: number }>`
          SELECT previewed_at FROM journal_posting_previews WHERE journal_entry_id = ${journalEntryId}
        `;
        const previewedAt = rows[0]?.previewed_at;
        if (!previewedAt || Date.now() - previewedAt > PREVIEW_TTL_MS) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No recent preview found for this journalEntryId. Call preview_journal_entry_posting first, " +
                  "show the result to the user, and get their explicit confirmation before calling " +
                  "post_journal_entry again.",
              },
            ],
            isError: true,
          };
        }

        const result = await this.call("post_journal_entry", businessProfileId, "accounting.postJournalEntry", { journalEntryId });
        this.sql`DELETE FROM journal_posting_previews WHERE journal_entry_id = ${journalEntryId}`;
        return result;
      },
    );

    this.server.registerTool(
      "list_invoices",
      {
        description:
          "List invoices (income and expense) for this connection's business profile - full detail per invoice " +
          "(customer/supplier, line items, amounts, VAT, KSeF status), not just headers. Optionally filter by " +
          "date range (issueDate) and/or contractorTaxId (NIP) to pull every invoice for one counterparty, e.g. " +
          "\"all invoices from/to NIP 1234567890 this year\".",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          startDate: z.string().optional().describe("ISO date, YYYY-MM-DD - filters on issue date"),
          endDate: z.string().optional().describe("ISO date, YYYY-MM-DD - filters on issue date"),
          contractorTaxId: z.string().optional().describe("Counterparty NIP - returns only invoices for that customer/supplier"),
        },
      },
      async ({ businessProfileId, startDate, endDate, contractorTaxId }) =>
        this.call("list_invoices", businessProfileId, "invoices.listInvoices", { businessProfileId, startDate, endDate, contractorTaxId }),
    );

    const expenseItemSchema = z.object({
      name: z.string(),
      quantity: z.number().optional(),
      unitPrice: z.number().optional(),
      vatRate: z.number().describe("Percent, e.g. 23. Use -1 or vatExempt:true for zw (VAT-exempt)."),
      vatExempt: z.boolean().optional(),
      unit: z.string().optional(),
      totalNetValue: z.number().optional(),
      totalVatValue: z.number().optional(),
      totalGrossValue: z.number().optional(),
    });

    this.server.registerTool(
      "add_expense_invoice",
      {
        description:
          "Record a cost/expense invoice or receipt (e.g. one the caller already read and extracted from an " +
          "email or attachment - this tool does no OCR/extraction itself, pass in already-structured fields). " +
          "Requires a connection with draft_write or full_post permission tier. Always lands with " +
          "posting_status/accounting_status='needs_review' and acceptance_status='pending' - it is NEVER " +
          "auto-posted to the ledger or auto-accepted, regardless of input. A human reviews it in ksiegai's " +
          "normal expense/posting queue before it affects any balance or tax calculation.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          supplierName: z.string(),
          supplierTaxId: z.string().optional().describe("NIP, if known - used to match/dedupe the supplier"),
          supplierAddress: z.string().optional(),
          supplierPostalCode: z.string().optional(),
          supplierCity: z.string().optional(),
          number: z.string().optional().describe("The vendor's own invoice/receipt number, if shown on the document"),
          issueDate: z.string().describe("ISO date, YYYY-MM-DD"),
          dueDate: z.string().optional(),
          sellDate: z.string().optional(),
          currency: z.string().optional(),
          comments: z.string().optional(),
          bankAccountId: z.string().uuid().optional().describe("From list_bank_accounts - the account this expense should be paid from, if known"),
          items: z.array(expenseItemSchema).min(1),
        },
      },
      async (params) => this.call("add_expense_invoice", params.businessProfileId, "invoices.createExpense", params),
    );

    const incomeItemSchema = z.object({
      name: z.string().optional(),
      quantity: z.number().optional(),
      unitPrice: z.number().optional(),
      vatRate: z.number().describe("Percent, e.g. 23. Use -1 or vatExempt:true for zw (VAT-exempt)."),
      vatExempt: z.boolean().optional(),
      unit: z.string().optional(),
      totalNetValue: z.number().optional(),
      totalVatValue: z.number().optional(),
      totalGrossValue: z.number().optional(),
    });

    this.server.registerTool(
      "add_income_invoice",
      {
        description:
          "Record a sales/income invoice for a customer (e.g. one the caller was asked to prepare, or already " +
          "read structured fields for from a quote/order the user provided - this tool does no OCR/extraction " +
          "itself). Requires a connection with draft_write or full_post permission tier. Always lands with " +
          "posting_status/accounting_status='needs_review' and acceptance_status='pending', and NEVER touches " +
          "KSeF submission - it is never auto-posted to the ledger, never auto-accepted, and never auto-submitted " +
          "to KSeF, regardless of input. A human reviews it in ksiegai's normal invoice/posting queue, and KSeF " +
          "submission remains a separate explicit action in the app.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          customerName: z.string(),
          customerTaxId: z.string().optional().describe("NIP, if known - used to match/dedupe the customer"),
          customerAddress: z.string().optional(),
          customerPostalCode: z.string().optional(),
          customerCity: z.string().optional(),
          number: z.string().optional().describe("Invoice number, if the caller wants to assign one explicitly"),
          issueDate: z.string().describe("ISO date, YYYY-MM-DD"),
          dueDate: z.string().optional(),
          sellDate: z.string().optional(),
          currency: z.string().optional(),
          comments: z.string().optional(),
          bankAccountId: z.string().uuid().optional().describe("From list_bank_accounts - the account this invoice's payment should be received into, if known"),
          items: z.array(incomeItemSchema).min(1),
        },
      },
      async (params) => this.call("add_income_invoice", params.businessProfileId, "invoices.createIncome", params),
    );

    const documentCategorySchema = z
      .enum([
        "contracts_vehicles",
        "contracts_infrastructure",
        "contracts_services",
        "contracts_other",
        "resolutions",
        "licenses",
        "financial_statements",
        "tax_filings",
        "other",
      ])
      .describe("company_documents category");

    this.server.registerTool(
      "list_company_documents",
      {
        description:
          "List company documents (contracts, resolutions, licenses, financial statements, tax filings, etc) " +
          "for this connection's business profile - metadata only (title, category, dates, file name), not file " +
          "content. Use get_company_document for a single document's detail plus a download URL.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          category: documentCategorySchema.optional().describe("Filter to one category - omit to list all"),
        },
      },
      async ({ businessProfileId, category }) =>
        this.call("list_company_documents", businessProfileId, "documents.listCompanyDocuments", { businessProfileId, category }),
    );

    this.server.registerTool(
      "get_company_document",
      {
        description:
          "Get one company document's full metadata plus a time-limited (1 hour) signed download URL for its " +
          "file. Use list_company_documents first to find the documentId.",
        inputSchema: {
          businessProfileId: z.string().uuid().describe("This connection's business profile - not forwarded to the lookup itself, only used to authorize the call"),
          documentId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, documentId }) => {
        const docResult = await this.call("get_company_document", businessProfileId, "documents.getCompanyDocument", { id: documentId });
        if (docResult.isError) return docResult;
        let document: unknown = null;
        try {
          document = (JSON.parse(docResult.content[0].text) as { document?: unknown }).document ?? null;
        } catch {
          // fall through with document = null
        }
        if (!document) {
          return { content: [{ type: "text", text: `Document ${documentId} not found.` }], isError: true };
        }
        const urlResult = await this.call("get_company_document", businessProfileId, "documents.getDocumentUrl", { id: documentId });
        if (urlResult.isError) return urlResult;
        let url: unknown = null;
        try {
          url = JSON.parse(urlResult.content[0].text);
        } catch {
          // fall through with url = null
        }
        return { content: [{ type: "text", text: JSON.stringify({ document, ...(url as object) }) }] };
      },
    );

    this.server.registerTool(
      "upload_company_document",
      {
        description:
          "Upload a company document (e.g. a contract, resolution, license, or financial statement the caller " +
          "already has as a file) and record its metadata. The caller supplies the file's raw bytes as base64 - " +
          "this tool does no OCR/extraction, it just stores what it's given. Requires a connection with " +
          "draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          category: documentCategorySchema,
          fileName: z.string().describe("Original file name, e.g. umowa.pdf"),
          mimeType: z.string().optional().describe("e.g. application/pdf - defaults to application/octet-stream"),
          fileContentBase64: z.string().describe("The file's raw bytes, base64-encoded (a data: URL prefix is fine and will be stripped)"),
          title: z.string(),
          description: z.string().optional(),
          documentDate: z.string().optional().describe("ISO date, YYYY-MM-DD"),
          referenceNumber: z.string().optional(),
        },
      },
      async (params) => this.call("upload_company_document", params.businessProfileId, "documents.uploadCompanyDocument", params),
    );

    this.server.registerTool(
      "list_bank_accounts",
      {
        description: "List bank accounts for this connection's business profile (id, provider, IBAN, currency, linked COA account).",
        inputSchema: { businessProfileId: z.string().uuid() },
      },
      async ({ businessProfileId }) => this.callBank("list_bank_accounts", businessProfileId, "list-accounts", { businessProfileId }),
    );

    this.server.registerTool(
      "list_bank_transactions",
      {
        description:
          "List bank transactions for one bank account (from list_bank_accounts) - includes classification, " +
          "status (imported/needs_review/matched/posted/etc), and amounts. Defaults to the 200 most recent " +
          "transactions with no other filtering - narrow with startDate/endDate for a date range, or " +
          "status/classification/direction to answer things like 'unclassified transactions from June' or " +
          "'all expense payments last quarter'.",
        inputSchema: {
          businessProfileId: z.string().uuid().describe("This connection's business profile - not forwarded to the bank query itself, only used to authorize the call"),
          accountId: z.string().uuid(),
          startDate: z.string().optional().describe("ISO date, YYYY-MM-DD, inclusive"),
          endDate: z.string().optional().describe("ISO date, YYYY-MM-DD, inclusive"),
          status: z.enum(["imported", "needs_review", "matched", "posted", "reconciled"]).optional(),
          classification: z.enum([
            "invoice_payment", "expense_payment", "foreign_service_purchase", "shareholder_loan",
            "bank_loan", "loan_granted", "loan_repayment_received", "capital_contribution",
            "stripe_payout", "tax_payment", "salary", "bank_transfer", "fee", "other",
            "technical_verification_deposit", "technical_verification_reversal",
          ]).optional(),
          direction: z.enum(["credit", "debit"]).optional().describe("credit = money in (income), debit = money out (expense)"),
          limit: z.number().int().min(1).max(500).optional().describe("Defaults to 200, capped at 500"),
        },
      },
      async ({ businessProfileId, accountId, startDate, endDate, status, classification, direction, limit }) =>
        this.callBank("list_bank_transactions", businessProfileId, "list-transactions", { accountId, startDate, endDate, status, classification, direction, limit }),
    );

    this.server.registerTool(
      "find_bank_match_candidates",
      {
        description:
          "For one bank transaction (from list_bank_transactions), find candidate unpaid invoices (or, if the " +
          "transaction looks like a Stripe payout, candidate Stripe payouts) it could settle - scored by amount " +
          "and description match. Read-only, does not create a match itself - pass the chosen candidate's " +
          "invoiceId/stripePayoutDbId into match_bank_transaction_to_invoice (invoices) or " +
          "match_stripe_payout_to_bank_transaction (Stripe payouts) to actually link it.",
        inputSchema: {
          businessProfileId: z.string().uuid().describe("Not forwarded to the query, only used to authorize the call"),
          bankTransactionId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, bankTransactionId }) =>
        this.callBank("find_bank_match_candidates", businessProfileId, "find-match-candidates", { bankTransactionId }),
    );

    this.server.registerTool(
      "match_bank_transaction_to_invoice",
      {
        description:
          "Link a bank transaction to the invoice (or expense) it pays - the transaction flips to status " +
          "'matched'. Use find_bank_match_candidates first to get a scored invoiceId and confidence rather than " +
          "guessing. Requires a connection with draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid().describe("Not forwarded to the query, only used to authorize the call"),
          bankTransactionId: z.string().uuid(),
          invoiceId: z.string().uuid().describe("The matched invoice's id, from find_bank_match_candidates or list_invoices"),
          eventType: z.enum(["invoice", "expense"]).optional().default("invoice"),
          confidence: z.number().min(0).max(1).optional().default(1).describe("0-1, defaults to 1 for an explicit manual match"),
        },
      },
      async ({ businessProfileId, bankTransactionId, invoiceId, eventType, confidence }) =>
        this.callBank("match_bank_transaction_to_invoice", businessProfileId, "match-bank-transaction", {
          bankTransactionId,
          eventType,
          eventId: invoiceId,
          confidence,
          matchedBy: "manual",
        }),
    );

    const bankTxSchema = z.object({
      date: z.string().describe("ISO date, YYYY-MM-DD"),
      description: z.string(),
      amount: z.number().describe("Positive number - sign is carried by `direction`, not the amount"),
      currency: z.string(),
      direction: z.enum(["credit", "debit"]).describe("credit = money in, debit = money out"),
      counterpartyIban: z.string().optional(),
      counterpartyName: z.string().optional(),
      providerTransactionId: z.string().optional().describe("The bank's own transaction/reference id, if shown on the statement"),
    });

    this.server.registerTool(
      "import_bank_statement",
      {
        description:
          "Import bank transactions the caller already read and extracted from a statement (PDF, CSV, screenshot, " +
          "whatever - this tool does no parsing/OCR itself, pass in already-structured rows). Requires a " +
          "connection with draft_write or full_post permission tier. Lands every transaction as " +
          "status='imported'/'needs_review', same as any normal statement import - nothing is classified or " +
          "posted yet, use classify_bank_transaction and post_bank_transaction (after preview + user " +
          "confirmation) for that.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          bankAccountId: z.string().uuid().describe("From list_bank_accounts"),
          fileName: z.string().describe("A descriptive name for this import, e.g. the statement's own filename or period"),
          transactions: z.array(bankTxSchema).min(1),
        },
      },
      async ({ businessProfileId, bankAccountId, fileName, transactions }) => {
        const fileHash = await sha256Hex(JSON.stringify(transactions));
        const parsed = transactions.map((t) => ({
          date: t.date,
          description: t.description,
          amount: t.amount,
          amountMinor: Math.round(t.amount * 100),
          currency: t.currency,
          direction: t.direction,
          counterpartyIban: t.counterpartyIban ?? null,
          counterpartyName: t.counterpartyName ?? null,
          providerTransactionId: t.providerTransactionId ?? null,
          rawPayload: t,
        }));
        // file_format is a fixed DB enum for real machine-parseable bank
        // export formats (csv/mt940/camt053/etc) - this tool's input is
        // always AI-read/interpreted, never a parsed file, so it's always
        // tagged 'mcp_agent' rather than asking the AI to guess/misreport a
        // format it didn't actually parse.
        return this.callBank("import_bank_statement", businessProfileId, "import-bank-statement", {
          businessProfileId,
          data: { bankAccountId, fileName, fileHash, fileFormat: "mcp_agent", parsed, meta: {} },
        });
      },
    );

    const updateBankTxDataSchema = z.object({
      date: z.string().optional().describe("ISO date, YYYY-MM-DD"),
      description: z.string().optional(),
      amount: z.number().optional().describe("Positive number, same convention as import_bank_statement"),
      currency: z.string().optional(),
      type: z.enum(["income", "expense"]).optional(),
      counterparty: z.string().optional(),
      counterpartyName: z.string().optional(),
      counterpartyIban: z.string().optional(),
      category: z.string().optional(),
    });

    this.server.registerTool(
      "update_bank_transaction",
      {
        description:
          "Correct a bank transaction's own fields (e.g. a bad import — wrong date/amount/description/" +
          "counterparty). Requires draft_write or full_post tier. Rejected if the transaction's status is " +
          "posted or reconciled - reverse the journal entry first. Does NOT touch status/classification/" +
          "journal_entry_id - use classify_bank_transaction or the post/preview tools for those.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          bankTransactionId: z.string().uuid(),
          data: updateBankTxDataSchema,
        },
      },
      async ({ businessProfileId, bankTransactionId, data }) => {
        const patch: Record<string, unknown> = {
          date: data.date,
          description: data.description,
          amount: data.amount,
          currency: data.currency,
          type: data.type,
          counterparty: data.counterparty,
          counterparty_name: data.counterpartyName,
          counterparty_iban: data.counterpartyIban,
          category: data.category,
        };
        return this.callBank("update_bank_transaction", businessProfileId, "update-transaction", { bankTransactionId, data: patch });
      },
    );

    this.server.registerTool(
      "delete_bank_transaction",
      {
        description:
          "Permanently delete a bank transaction row (e.g. a duplicate or bad import). Requires draft_write or " +
          "full_post tier. Rejected if the transaction's status is posted or reconciled - reverse the journal " +
          "entry and void it first. Not reversible via this tool.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          bankTransactionId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, bankTransactionId }) =>
        this.callBank("delete_bank_transaction", businessProfileId, "delete-transaction", { bankTransactionId }),
    );

    this.server.registerTool(
      "classify_bank_transaction",
      {
        description:
          "Classify a bank transaction (e.g. invoice_payment, expense_payment, foreign_service_purchase, " +
          "shareholder_loan, bank_loan, loan_granted, loan_repayment_received, capital_contribution, " +
          "stripe_payout, tax_payment, salary, bank_transfer, fee, technical_verification_deposit, other). " +
          "Requires a connection with draft_write or full_post permission tier. Always leaves " +
          "status='needs_review' regardless of confidence - classification alone never posts anything or marks " +
          "a transaction ready.",
        inputSchema: {
          businessProfileId: z.string().uuid().describe("This connection's business profile - not forwarded to the classification itself, only used to authorize the call"),
          bankTransactionId: z.string().uuid(),
          classification: z.string(),
          notes: z.string().optional().describe("Brief reasoning for this classification - shown to the human reviewer"),
        },
      },
      async ({ businessProfileId, bankTransactionId, classification, notes }) =>
        this.callBank("classify_bank_transaction", businessProfileId, "classify-bank-transaction", { bankTransactionId, classification, status: "needs_review", notes }),
    );

    this.server.registerTool(
      "preview_bank_transaction_posting",
      {
        description:
          "Dry-run preview of posting a bank transaction to the ledger - shows the transaction detail and which " +
          "chart-of-accounts account would be credited/debited, but posts NOTHING. Required before " +
          "post_bank_transaction will succeed (same bankTransactionId+creditAccountId, within 15 minutes). " +
          "Show this briefing to the user and get their explicit go-ahead before calling post_bank_transaction - " +
          "never chain straight from preview to post without the user confirming in between.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          accountId: z.string().uuid().describe("The bank account this transaction belongs to"),
          bankTransactionId: z.string().uuid(),
          creditAccountId: z.string().uuid().describe("The chart-of-accounts account on the other side of the posting - see get_chart_of_accounts"),
        },
      },
      async ({ businessProfileId, accountId, bankTransactionId, creditAccountId }) => {
        const listResult = await this.callBank("preview_bank_transaction_posting", businessProfileId, "list-transactions", { accountId });
        if (listResult.isError) return listResult;
        let briefing: unknown = null;
        try {
          const parsed = JSON.parse(listResult.content[0].text) as { data?: any[] };
          briefing = (parsed.data || []).find((t) => t.id === bankTransactionId) ?? null;
        } catch {
          // fall through with briefing = null
        }
        if (!briefing) {
          return { content: [{ type: "text", text: `Transaction ${bankTransactionId} not found on account ${accountId}.` }], isError: true };
        }
        this.sql`INSERT OR REPLACE INTO posting_previews (bank_transaction_id, credit_account_id, previewed_at) VALUES (${bankTransactionId}, ${creditAccountId}, ${Date.now()})`;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                previewOnly: true,
                nothingPosted: true,
                transaction: briefing,
                wouldCreditAccountId: creditAccountId,
                instructions: "Show this to the user. Only call post_bank_transaction after they explicitly confirm.",
              }),
            },
          ],
        };
      },
    );

    this.server.registerTool(
      "post_bank_transaction",
      {
        description:
          "Post a bank transaction to the ledger - creates a REAL journal entry, not reversible via this tool. " +
          "Requires a connection with full_post permission tier, AND a matching preview_bank_transaction_posting " +
          "call for the exact same bankTransactionId+creditAccountId within the last 15 minutes, AND the user has " +
          "explicitly confirmed after seeing that preview. Never call this speculatively or without the user's " +
          "explicit go-ahead. After posting, give the user a short briefing of exactly what was posted (accounts, " +
          "amounts, date).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          bankTransactionId: z.string().uuid(),
          creditAccountId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, bankTransactionId, creditAccountId }) => {
        const rows = this.sql<{ previewed_at: number }>`
          SELECT previewed_at FROM posting_previews
          WHERE bank_transaction_id = ${bankTransactionId} AND credit_account_id = ${creditAccountId}
        `;
        const previewedAt = rows[0]?.previewed_at;
        if (!previewedAt || Date.now() - previewedAt > PREVIEW_TTL_MS) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No recent preview found for this exact bankTransactionId+creditAccountId pair. Call " +
                  "preview_bank_transaction_posting first, show the result to the user, and get their explicit " +
                  "confirmation before calling post_bank_transaction again.",
              },
            ],
            isError: true,
          };
        }

        const result = await this.callBank("post_bank_transaction", businessProfileId, "post-bank-transaction", { bankTransactionId, creditAccountId });
        this.sql`DELETE FROM posting_previews WHERE bank_transaction_id = ${bankTransactionId} AND credit_account_id = ${creditAccountId}`;
        if (result.isError) return result;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                briefing: `Posted bank transaction ${bankTransactionId} to the ledger, crediting account ${creditAccountId}.`,
                result: JSON.parse(result.content[0].text),
              }),
            },
          ],
        };
      },
    );

    // Team management - wraps ksiegai-workspace's `team` domain (all
    // RLS-scoped, no service-role bypass; see ksef-ai's
    // ksiegai-workspace/domains/team/README-equivalent header comments on
    // each route). invite_team_member/resend/cancel/update/remove are
    // draft_write tier - not a ledger posting, but a real external side
    // effect (an email to a third party) or an access-control change,
    // deliberately gated the same as this project's other non-trivial
    // writes rather than read_only.
    const TEAM_ROLE_ENUM = z.enum(["admin", "accountant", "pelnomocnik", "viewer"]);

    this.server.registerTool(
      "list_team_members",
      {
        description: "List the members of a business profile's team (owner + everyone invited and accepted), with their role.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
        },
      },
      async ({ businessProfileId }) =>
        this.call("list_team_members", businessProfileId, "team.listMembers", { businessProfileId }),
    );

    this.server.registerTool(
      "list_team_invitations",
      {
        description: "List all invitations sent for a business profile (pending, accepted, declined, expired, cancelled).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
        },
      },
      async ({ businessProfileId }) =>
        this.call("list_team_invitations", businessProfileId, "team.listInvitations", { businessProfileId }),
    );

    this.server.registerTool(
      "invite_team_member",
      {
        description:
          "Invite someone to join a business profile's team by email - sends them a real invite email with an " +
          "accept link. Requires draft_write or full_post permission tier. Roles: admin (full operational access, " +
          "can invite others), accountant (invoices/expenses/documents/reports), pelnomocnik (documents + legal " +
          "representation), viewer (read-only). Confirm the recipient's email and intended role with the user " +
          "before calling this - it immediately sends a real email.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          email: z.string().email(),
          role: TEAM_ROLE_ENUM,
          message: z.string().optional().describe("Optional personal note included in the invite email"),
        },
      },
      async ({ businessProfileId, email, role, message }) =>
        this.call("invite_team_member", businessProfileId, "team.createInvitation", { businessProfileId, email, role, message }),
    );

    this.server.registerTool(
      "resend_team_invitation",
      {
        description: "Resend the invite email for an existing pending invitation (same link/token) - e.g. it got lost or spam-filtered.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          invitationId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, invitationId }) =>
        this.call("resend_team_invitation", businessProfileId, "team.resendInvitation", { businessProfileId, invitationId }),
    );

    this.server.registerTool(
      "cancel_team_invitation",
      {
        description: "Cancel a pending team invitation before it's accepted.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          invitationId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, invitationId }) =>
        this.call("cancel_team_invitation", businessProfileId, "team.cancelInvitation", { businessProfileId, invitationId }),
    );

    this.server.registerTool(
      "update_team_member_role",
      {
        description:
          "Change an existing team member's role (also resets their permission preset to that role's defaults - " +
          "see invite_team_member's description for what each role grants). Cannot change the owner's role.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          memberId: z.string().uuid(),
          role: TEAM_ROLE_ENUM,
        },
      },
      async ({ businessProfileId, memberId, role }) =>
        this.call("update_team_member_role", businessProfileId, "team.updateMember", { businessProfileId, memberId, updates: { role } }),
    );

    this.server.registerTool(
      "remove_team_member",
      {
        description:
          "Remove a member from a business profile's team - they immediately lose access. Cannot remove the " +
          "owner. Confirm with the user before calling this - it's not reversible from here (they'd need a new " +
          "invitation to rejoin).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          memberId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, memberId }) =>
        this.call("remove_team_member", businessProfileId, "team.removeMember", { businessProfileId, memberId }),
    );

    // === Governance / uchwały / KSH-210 (T-418 continuation, 2026-08-18) ===
    // See ~/.claude/plans/cozy-skipping-meadow.md for the full design. The
    // resolutions/decisions/authority-chain machinery already existed
    // (including KSH art. 210 §1 conflict detection) - these tools are the
    // first time any of it is exposed to an AI agent.

    this.server.registerTool(
      "list_resolutions",
      {
        description:
          "List uchwały (shareholder/board resolutions) for this business profile. Includes KSH art. 210 §1 " +
          "proxy-appointment resolutions (resolutionType='article_210_proxy_appointment').",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          status: z.string().optional().describe("draft | adopted | executed"),
          resolutionType: z.string().optional(),
        },
      },
      async ({ businessProfileId, status, resolutionType }) =>
        this.call("list_resolutions", businessProfileId, "spolka.listResolutions", { businessProfileId, status, resolutionType }),
    );

    this.server.registerTool(
      "get_resolution",
      {
        description:
          "Full detail for one uchwała: the resolution itself, per-voter vote records, and the latest cached " +
          "quorum/pass-fail validation result.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          resolutionId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, resolutionId }) =>
        this.call("get_resolution", businessProfileId, "spolka.getResolution", { businessProfileId, resolutionId }),
    );

    this.server.registerTool(
      "list_decisions",
      {
        description:
          "List decisions (the mandate/authorization layer behind resolutions - every contract/invoice/expense " +
          "should trace back to one of these). decisionType is 'strategic_shareholders' (uchwała wspólników-level) " +
          "or 'operational_board' (uchwała zarządu-level, must have a parent strategic decision).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          status: z.string().optional().describe("draft | pending_approval | active | paused | amendment_pending | amended | revocation_pending | revoked | rejected | cancelled"),
          category: z.string().optional(),
          decisionType: z.enum(["strategic_shareholders", "operational_board"]).optional(),
        },
      },
      async ({ businessProfileId, status, category, decisionType }) =>
        this.call("list_decisions", businessProfileId, "spolka.listDecisions", { businessProfileId, status, category, decisionType }),
    );

    this.server.registerTool(
      "get_decision",
      {
        description: "Single decision by id - the mandate/authorization row's full detail.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          decisionId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, decisionId }) =>
        this.call("get_decision", businessProfileId, "spolka.getDecision", { businessProfileId, decisionId }),
    );

    this.server.registerTool(
      "get_authority_chain",
      {
        description:
          "The full strategic->mandate->board->execution-object authority chain for a contract/invoice/expense, " +
          "plus its cached governance validation (whether a valid decision authorizes it, and whether it needs a " +
          "KSH art. 210 §1 proxy resolution). Reads the cache only - call refresh_governance_validation first if " +
          "you need this recomputed after a recent change.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          objectType: z.enum(["contract", "invoice", "expense"]),
          objectId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, objectType, objectId }) =>
        this.call("get_authority_chain", businessProfileId, "spolka.getAuthorityChain", { businessProfileId, objectType, objectId }),
    );

    this.server.registerTool(
      "check_ksh_compliance_for_loan",
      {
        description:
          "Check a shareholder/board-member loan against KSH (Kodeks spółek handlowych) art. 15 (board-member " +
          "loan requires shareholder consent, no threshold), art. 210 §1 (if the counterparty is a board member, " +
          "the company must be represented by the rada nadzorcza or a shareholder-appointed pełnomocnik - the " +
          "board member can't sign for both sides), and art. 230 (loan exceeding 2x share capital needs consent). " +
          "Returns which articles apply, whether each is satisfied, and an overall compliant flag. Use this " +
          "before treating a shareholder loan as properly authorized.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          loanId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, loanId }) =>
        this.call("check_ksh_compliance_for_loan", businessProfileId, "spolka.checkKshComplianceForLoan", { businessProfileId, loanId }),
    );

    this.server.registerTool(
      "explain_transaction_governance",
      {
        description:
          "Explain whether an already-imported bank transaction required a corporate decision/resolution, and " +
          "whether an existing one covers it. Read-only - never creates, modifies, or backdates anything. " +
          "Returns a result_state (not_required / covered_by_existing_decision / missing_decision / " +
          "missing_signatures / possibly_requires_decision / requires_more_information / requires_legal_review / " +
          "documentation_required_but_not_resolution / chronology_problem), which rule fired, the relevant " +
          "transaction and governance facts, which decision/resolution (if any) was considered and why it did or " +
          "didn't cover it, what information is missing, a confidence level, and whether an AI may safely prepare " +
          "a draft decision (ai_may_draft) - always false for chronology_problem/requires_legal_review/" +
          "requires_more_information, since those must never be resolved by fabricating or backdating a decision.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          bankTransactionId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, bankTransactionId }) =>
        this.call("explain_transaction_governance", businessProfileId, "spolka.explainTransactionGovernance", { businessProfileId, bankTransactionId }),
    );

    this.server.registerTool(
      "refresh_governance_validation",
      {
        description:
          "Recompute the cached governance/authority-chain validation (incl. KSH art. 210 §1 conflict detection) " +
          "for a contract/invoice/expense. Only updates a validation-cache table, doesn't change any real " +
          "authorization - call this before get_authority_chain if you suspect the cached result is stale " +
          "(e.g. after creating a new decision or proxy resolution).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          objectType: z.enum(["contract", "invoice", "expense"]),
          objectId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, objectType, objectId }) =>
        this.call("refresh_governance_validation", businessProfileId, "spolka.refreshGovernanceValidation", { businessProfileId, objectType, objectId }),
    );

    this.server.registerTool(
      "refresh_representation_validation",
      {
        description:
          "Recompute who must sign/represent the company for a contract (incl. its own KSH art. 210 §1 proxy " +
          "check) - a narrower sibling of refresh_governance_validation focused on signing authority rather than " +
          "the full mandate chain. Only meaningful for contracts today.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          objectType: z.enum(["contract", "invoice", "expense", "company_document"]),
          objectId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, objectType, objectId }) =>
        this.call("refresh_representation_validation", businessProfileId, "spolka.refreshRepresentationValidation", { businessProfileId, objectType, objectId }),
    );

    this.server.registerTool(
      "create_resolution",
      {
        description:
          "Draft a new uchwała (shareholder/board resolution) - ALWAYS created as status='draft', never " +
          "auto-adopted (adoption requires the real vote/quorum flow in the app). For a KSH art. 210 §1 proxy " +
          "appointment (needed when a contract/loan involves a board member as counterparty), set " +
          "resolutionType='article_210_proxy_appointment', adoptingBody='shareholders', and exactly one of " +
          "article210ProxyShareholderId / article210ProxyRepresentativeBoardMemberId / " +
          "article210ProxyRepresentativeExternalName to name who represents the company for that matter.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          resolutionNumber: z.string(),
          resolutionType: z.string().describe("e.g. 'article_210_proxy_appointment', or any other resolution type used in this company"),
          resolutionDate: z.string().describe("ISO date, YYYY-MM-DD"),
          title: z.string(),
          content: z.string().optional(),
          fiscalYear: z.number().optional(),
          amount: z.number().optional(),
          adoptingBody: z.enum(["shareholders", "board"]).optional().describe("Defaults to 'shareholders'"),
          meetingId: z.string().uuid().optional(),
          article210ProxyShareholderId: z.string().uuid().optional(),
          article210ProxyBoardMemberId: z.string().uuid().optional().describe("The board member this proxy resolution concerns (the conflicted party)"),
          article210Scope: z.string().optional(),
          article210ProxyRepresentativeType: z.enum(["shareholder", "board_member", "external"]).optional(),
          article210ProxyRepresentativeBoardMemberId: z.string().uuid().optional(),
          article210ProxyRepresentativeExternalName: z.string().optional(),
          subjectEntityType: z.enum(["shareholder", "board_member", "company", "external_person"]).optional(),
          subjectShareholderId: z.string().uuid().optional(),
          subjectBoardMemberId: z.string().uuid().optional(),
          subjectExternalName: z.string().optional(),
        },
      },
      async ({ businessProfileId, ...rest }) =>
        this.call("create_resolution", businessProfileId, "spolka.createResolution", { businessProfileId, ...rest }),
    );

    this.server.registerTool(
      "create_decision",
      {
        description:
          "Draft a new decision (mandate/authorization) - ALWAYS created as status='draft', never immediately " +
          "active. A human must review and activate it in the app before it authorizes anything. decisionType " +
          "'operational_board' requires parentDecisionId pointing at a 'strategic_shareholders' decision.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          title: z.string(),
          decisionType: z.enum(["strategic_shareholders", "operational_board"]),
          category: z.enum([
            "consents", "conflict_of_interest", "operational_activity", "company_financing", "compensation",
            "sales_services", "operational_costs", "fixed_asset_acquisition", "lending_for_use_contracts",
            "vehicle_purchase", "vehicle_rental", "vehicle_sale", "b2b_contracts", "cash_management",
            "project_governance", "custom_projects", "other",
          ]),
          resolutionId: z.string().uuid().optional().describe("The uchwała this decision derives from, if any"),
          parentDecisionId: z.string().uuid().optional(),
          description: z.string().optional(),
          scopeDescription: z.string().optional(),
          amountLimit: z.number().optional(),
          currency: z.string().optional(),
          validFrom: z.string().optional().describe("ISO date"),
          validTo: z.string().optional().describe("ISO date"),
          allowedCounterparties: z.array(z.object({ name: z.string(), nip: z.string().optional() })).optional(),
          decisionBody: z.enum(["ZARZAD", "WSPOLNICY"]).optional().describe("Defaults to 'WSPOLNICY'"),
          authorityLevel: z.enum(["shareholders", "board", "manager"]).optional(),
          legalReference: z.string().optional(),
        },
      },
      async ({ businessProfileId, ...rest }) =>
        this.call("create_decision", businessProfileId, "spolka.createDecision", { businessProfileId, ...rest }),
    );

    this.server.registerTool(
      "pause_decision",
      {
        description:
          "Freeze an active decision without revoking it - blocks it from authorizing new actions while flagged " +
          "for review, reversibly (unlike revocation, which goes through an approval chain). Use this when you " +
          "suspect a decision is being relied on incorrectly (e.g. missing an art. 210 proxy) and want to stop " +
          "further action on it pending human review. Requires draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          decisionId: z.string().uuid(),
          reason: z.string().optional(),
        },
      },
      async ({ businessProfileId, decisionId, reason }) =>
        this.call("pause_decision", businessProfileId, "spolka.pauseDecision", { businessProfileId, decisionId, reason }),
    );

    this.server.registerTool(
      "resume_decision",
      {
        description:
          "Restore a paused decision back to active, letting it authorize actions again. Higher trust than " +
          "pause_decision (restoring authority is the risk-increasing direction) - requires full_post permission " +
          "tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          decisionId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, decisionId }) =>
        this.call("resume_decision", businessProfileId, "spolka.resumeDecision", { businessProfileId, decisionId }),
    );

    // === Contracts, all types (T-418 continuation, 2026-08-18) ===

    const CONTRACT_TYPE_ENUM = z.enum([
      "general", "employment", "service", "lease", "rental", "lending_for_use", "loan",
      "loan_shareholder", "capital_contribution", "purchase", "board_member",
      "management_board", "supervisory_board", "nda", "partnership", "other",
    ]);

    this.server.registerTool(
      "list_contracts",
      {
        description: "List all contracts for this business profile (any contract type).",
        inputSchema: { businessProfileId: z.string().uuid() },
      },
      async ({ businessProfileId }) =>
        this.call("list_contracts", businessProfileId, "contracts.listByBusinessProfile", { businessProfileId }),
    );

    this.server.registerTool(
      "get_contract",
      {
        description: "Single contract by id, full detail.",
        inputSchema: { businessProfileId: z.string().uuid(), contractId: z.string().uuid() },
      },
      async ({ businessProfileId, contractId }) =>
        this.call("get_contract", businessProfileId, "contracts.getContract", { businessProfileId, contractId }),
    );

    this.server.registerTool(
      "create_contract",
      {
        description:
          "Create a contract of any type (general, employment, service, lease, rental, lending_for_use, loan, " +
          "loan_shareholder, capital_contribution, purchase, board_member, management_board, supervisory_board, " +
          "nda, partnership, other). ALWAYS created inert (lifecycle_state='draft') regardless of what you " +
          "specify - a human must review and activate it in the app. If boardMemberId is set, the response " +
          "includes a warning to check_ksh_compliance_for_loan / get_authority_chain before treating it as " +
          "authorized (KSH art. 210 §1 may require a proxy resolution). If decisionId is set, it must belong to " +
          "this business profile and be an active decision - otherwise the call is rejected. Requires " +
          "draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          contractType: CONTRACT_TYPE_ENUM,
          number: z.string().optional().describe("Contract number/reference; auto-generated if omitted"),
          customerId: z.string().uuid().optional(),
          issueDate: z.string().optional().describe("ISO date, defaults to today"),
          validFrom: z.string().optional().describe("ISO date, defaults to today"),
          validTo: z.string().optional(),
          subject: z.string().optional(),
          content: z.string().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          expectedTotalValue: z.number().optional(),
          expectedMonthlyValue: z.number().optional(),
          billingFrequency: z.string().optional(),
          currency: z.string().optional().describe("Defaults to PLN"),
          paymentTerms: z.number().optional().describe("Days, defaults to 14"),
          boardMemberId: z.string().uuid().optional().describe("Set when the counterparty is a board member - triggers a KSH art. 210 warning"),
          documentCategory: z.enum(["transactional_payout", "transactional_payin", "informational"]).optional(),
          expectedAmount: z.number().optional(),
          paymentFrequency: z.enum(["one_time", "monthly", "quarterly", "annual", "custom"]).optional(),
          decisionId: z.string().uuid().optional().describe("Authorizing decision - must be active and belong to this business profile"),
          decisionReference: z.string().optional(),
          financingKind: z.enum(["none", "loan", "rental", "other"]).optional(),
          loanSubtype: z.enum(["regular", "shareholder"]).optional(),
          loanPartyType: z.enum(["shareholder", "bank", "b2b", "b2c", "other"]).optional(),
        },
      },
      async ({ businessProfileId, ...rest }) =>
        this.call("create_contract", businessProfileId, "contracts.create", { businessProfileId, ...rest }),
    );

    this.server.registerTool(
      "update_contract",
      {
        description:
          "Edit an existing contract (partial update - only pass fields you want to change). Does NOT support " +
          "changing lifecycle_state (activation is a separate, not-yet-built capability) - this tool can only " +
          "edit a contract's details, never move it out of draft. Requires draft_write or full_post permission " +
          "tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          contractId: z.string().uuid(),
          customerId: z.string().uuid().optional(),
          subject: z.string().optional(),
          content: z.string().optional(),
          contractType: CONTRACT_TYPE_ENUM.optional(),
          validTo: z.string().optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          expectedTotalValue: z.number().optional(),
          expectedMonthlyValue: z.number().optional(),
          expectedAmount: z.number().optional(),
          boardMemberId: z.string().uuid().optional(),
        },
      },
      async ({ businessProfileId, contractId, ...patch }) =>
        this.call("update_contract", businessProfileId, "contracts.update", { businessProfileId, contractId, ...patch }),
    );

    // === Compliance checklist tasks (T-418 continuation, 2026-08-18) ===
    // "What compliance deadlines does this company still have outstanding" —
    // CRBR, konto organizacji, ZAW-FA, e-Doręczenia, KSeF activation, etc.
    // (see checklist_rules seed data). list_checklist_tasks/list_checklist_rules
    // wrap gateway routes that already existed (read-only, unused by MCP
    // until now); update_checklist_task_status is a new write route.

    this.server.registerTool(
      "list_checklist_tasks",
      {
        description:
          "List compliance checklist tasks for this business profile (CRBR, konto organizacji w e-Urząd " +
          "Skarbowy, ZAW-FA, e-Doręczenia, KSeF activation, and other company-lifecycle deadlines). Each task " +
          "has a status (todo/done/blocked/skipped/not_applicable) and, when relevant, a due_date. Use this to " +
          "answer 'what compliance tasks are still outstanding for this company'.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          domain: z.string().optional().describe("Filter by domain, e.g. 'company'"),
        },
      },
      async ({ businessProfileId, domain }) =>
        this.call("list_checklist_tasks", businessProfileId, "personal.getChecklistTasks", { businessProfileId, domain }),
    );

    this.server.registerTool(
      "list_checklist_rules",
      {
        description:
          "List the active checklist rule definitions (the templates checklist tasks are generated from) - " +
          "titles, descriptions, and which entity types/tax regimes each rule applies to. The rules themselves " +
          "are global, not business-profile-scoped, but businessProfileId is still required (used for connection " +
          "auth/tier checks, same as every other tool).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          domain: z.string().optional().describe("Filter by domain, e.g. 'company'"),
        },
      },
      async ({ businessProfileId, domain }) =>
        this.call("list_checklist_rules", businessProfileId, "personal.getActiveChecklistRules", { domain }),
    );

    this.server.registerTool(
      "update_checklist_task_status",
      {
        description:
          "Mark a compliance checklist task's status (todo/done/blocked/skipped/not_applicable). Setting 'done' " +
          "stamps completed_at/completed_by; moving away from 'done' clears them. Requires draft_write or " +
          "full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          taskId: z.string().uuid(),
          status: z.enum(["todo", "done", "blocked", "skipped", "not_applicable"]),
        },
      },
      async ({ businessProfileId, taskId, status }) =>
        this.call("update_checklist_task_status", businessProfileId, "personal.updateChecklistTaskStatus", { businessProfileId, taskId, status }),
    );

    // === Stripe reconciliation (T-418 continuation, 2026-08-18) ===
    // Owner-manual Stripe integration (a business's own Stripe API key,
    // distinct from Stripe Connect hosted checkout). Flow: list_payment_provider_accounts
    // to find paymentProviderAccountId -> import_stripe_fees/import_stripe_payouts
    // to pull fresh data from Stripe's live API for a period -> list_stripe_fee_summaries/
    // list_stripe_fee_items/list_stripe_payouts/get_stripe_period_settlement to
    // review it (or check get_posting_queue, which already surfaces settlements
    // needing posting with a concrete debit/credit template) -> draft_journal_entry
    // + post_journal_entry to actually post -> link_stripe_settlement_journal_entry
    // / link_stripe_fee_summary_journal_entry to close the loop so it stops
    // reappearing as needing action.

    this.server.registerTool(
      "list_payment_provider_accounts",
      {
        description:
          "List this business's connected payment provider accounts (Stripe, Revolut, etc. — owner-manual " +
          "integrations, not Stripe Connect hosted checkout). Returns id, provider, display name, mode " +
          "(test/live), and status - never secret/API-key values. Call this first to get paymentProviderAccountId, " +
          "required by every other Stripe tool.",
        inputSchema: { businessProfileId: z.string().uuid() },
      },
      async ({ businessProfileId }) =>
        this.call("list_payment_provider_accounts", businessProfileId, "billing.listPaymentProviderAccounts", { businessProfileId }),
    );

    this.server.registerTool(
      "import_stripe_fees",
      {
        description:
          "Pull fresh fee data from Stripe's LIVE API for one account and month - scans every balance " +
          "transaction in the period, upserts stripe_fee_items (idempotent, safe to re-run), and derives/updates " +
          "the period's settlement (gross sales, refunds, fees, expected payout). May take a few seconds. " +
          "Requires draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          paymentProviderAccountId: z.string().uuid(),
          year: z.number().int(),
          month: z.number().int().min(1).max(12),
        },
      },
      async ({ businessProfileId, paymentProviderAccountId, year, month }) =>
        this.call("import_stripe_fees", businessProfileId, "billing.importStripeFees", { businessProfileId, paymentProviderAccountId, year, month }),
    );

    this.server.registerTool(
      "import_stripe_payouts",
      {
        description:
          "Pull fresh payout data from Stripe's LIVE API for one account and month - upserts stripe_payouts and " +
          "stripe_payout_items (idempotent, safe to re-run). May take a few seconds. Requires draft_write or " +
          "full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          paymentProviderAccountId: z.string().uuid(),
          year: z.number().int(),
          month: z.number().int().min(1).max(12),
        },
      },
      async ({ businessProfileId, paymentProviderAccountId, year, month }) =>
        this.call("import_stripe_payouts", businessProfileId, "billing.importStripePayouts", { businessProfileId, paymentProviderAccountId, year, month }),
    );

    this.server.registerTool(
      "list_stripe_fee_summaries",
      {
        description:
          "List monthly Stripe fee summaries (one per account per month) - total fees, reverse-charge VAT, and " +
          "posting status (draft/posted/needs_review/confirmed).",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          paymentProviderAccountId: z.string().uuid().optional(),
          status: z.enum(["draft", "posted", "needs_review", "confirmed"]).optional(),
        },
      },
      async ({ businessProfileId, paymentProviderAccountId, status }) =>
        this.call("list_stripe_fee_summaries", businessProfileId, "billing.listStripeFeeSummaries", { businessProfileId, paymentProviderAccountId, status }),
    );

    this.server.registerTool(
      "list_stripe_fee_items",
      {
        description: "List the individual fee line items behind one monthly fee summary (from list_stripe_fee_summaries).",
        inputSchema: { businessProfileId: z.string().uuid(), summaryId: z.string().uuid() },
      },
      async ({ businessProfileId, summaryId }) =>
        this.call("list_stripe_fee_items", businessProfileId, "billing.listStripeFeeItems", { summaryId }),
    );

    this.server.registerTool(
      "get_stripe_period_settlement",
      {
        description:
          "Full reconciliation detail for one account+month: gross sales, refunds, disputes, Stripe fees, " +
          "reverse-charge VAT, expected payout, and which journal entries (if any) have posted the sale/fee " +
          "legs. get_posting_queue already surfaces settlements needing posting with a ready debit/credit " +
          "template - use this tool for direct lookup of a specific period instead.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          paymentProviderAccountId: z.string().uuid(),
          periodYear: z.number().int(),
          periodMonth: z.number().int().min(1).max(12),
        },
      },
      async ({ businessProfileId, paymentProviderAccountId, periodYear, periodMonth }) =>
        this.call("get_stripe_period_settlement", businessProfileId, "billing.getStripePeriodSettlement", { businessProfileId, paymentProviderAccountId, periodYear, periodMonth }),
    );

    this.server.registerTool(
      "list_stripe_payouts",
      {
        description:
          "List Stripe payouts (transfers to the business's bank account) - amount, arrival date, and whether " +
          "it's been matched to a bank transaction yet.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          paymentProviderAccountId: z.string().uuid().optional(),
          bankMatchStatus: z.enum(["awaiting", "matched", "manual_confirmed"]).optional(),
          limit: z.number().int().optional(),
        },
      },
      async ({ businessProfileId, paymentProviderAccountId, bankMatchStatus, limit }) =>
        this.call("list_stripe_payouts", businessProfileId, "billing.listStripePayouts", { businessProfileId, paymentProviderAccountId, bankMatchStatus, limit }),
    );

    this.server.registerTool(
      "list_stripe_payout_items",
      {
        description: "List the individual payments/fees/refunds/adjustments that make up one Stripe payout (from list_stripe_payouts).",
        inputSchema: { businessProfileId: z.string().uuid(), stripePayoutId: z.string().uuid() },
      },
      async ({ businessProfileId, stripePayoutId }) =>
        this.call("list_stripe_payout_items", businessProfileId, "billing.listStripePayoutItems", { stripePayoutId }),
    );

    this.server.registerTool(
      "link_stripe_settlement_journal_entry",
      {
        description:
          "After posting a journal entry for a Stripe settlement's sale or fee leg (via draft_journal_entry + " +
          "post_journal_entry, using get_posting_queue's template), call this to record the link and update the " +
          "settlement's status - otherwise it keeps reappearing in get_posting_queue forever. A settlement can " +
          "need both a sale and a fee entry; status only becomes 'posted' once both applicable legs are linked.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          settlementId: z.string().uuid(),
          subKind: z.enum(["sale", "fee"]),
          journalEntryId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, settlementId, subKind, journalEntryId }) =>
        this.call("link_stripe_settlement_journal_entry", businessProfileId, "billing.linkStripeSettlementJournalEntry", { settlementId, subKind, journalEntryId }),
    );

    this.server.registerTool(
      "link_stripe_fee_summary_journal_entry",
      {
        description:
          "After posting a journal entry for a Stripe monthly fee summary (via draft_journal_entry + " +
          "post_journal_entry), call this to mark the summary as posted and record the link.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          summaryId: z.string().uuid(),
          journalEntryId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, summaryId, journalEntryId }) =>
        this.call("link_stripe_fee_summary_journal_entry", businessProfileId, "billing.linkStripeFeeSummaryJournalEntry", { businessProfileId, summaryId, journalEntryId }),
    );

    this.server.registerTool(
      "list_stripe_invoice_payments",
      {
        description:
          "List recent Stripe Connect invoice payments (hosted checkout, not the fee/payout reconciliation " +
          "tables above) for this business, each already resolved to its ksiegai invoice number and customer " +
          "name where applicable - use this to answer 'which invoice did this Stripe payment pay' or 'has " +
          "invoice X been paid via Stripe'. Most recent 20.",
        inputSchema: { businessProfileId: z.string().uuid() },
      },
      async ({ businessProfileId }) =>
        this.call("list_stripe_invoice_payments", businessProfileId, "billing.getStripePaymentTransactions", { businessProfileId }),
    );

    this.server.registerTool(
      "match_stripe_payout_to_bank_transaction",
      {
        description:
          "Bank-transfer matching: for Stripe payouts still awaiting a match (or one specific payoutDbId), " +
          "looks for a bank_transactions row within ±4 days of the payout's arrival date with a matching amount " +
          "and links them (bank_match_status -> 'matched'). Requires draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          payoutDbId: z.string().uuid().optional().describe("Omit to attempt matching for every awaiting payout"),
        },
      },
      async ({ businessProfileId, payoutDbId }) =>
        this.call("match_stripe_payout_to_bank_transaction", businessProfileId, "billing.matchStripePayoutToBankTransaction", { businessProfileId, payoutDbId }),
    );

    this.server.registerTool(
      "auto_classify_stripe_bank_transactions",
      {
        description:
          "Auto-classify unclassified expense bank transactions that look like Stripe transfers (counterparty/" +
          "description containing 'stripe') - only acts for VAT-exempt business profiles (returns classified:0 " +
          "otherwise, by design). Requires draft_write or full_post permission tier.",
        inputSchema: { businessProfileId: z.string().uuid() },
      },
      async ({ businessProfileId }) =>
        this.call("auto_classify_stripe_bank_transactions", businessProfileId, "billing.autoClassifyStripeBankTransactions", { businessProfileId }),
    );

    this.server.registerTool(
      "confirm_stripe_payout",
      {
        description:
          "Manually confirm a Stripe payout (bank_match_status -> 'matched' if bankTransactionId given, else " +
          "'manual_confirmed') and record its financial_event. This is a bookkeeping record, not a journal " +
          "entry - still use draft_journal_entry/post_journal_entry separately for the actual GL posting. " +
          "Requires draft_write or full_post permission tier.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          stripePayoutDbId: z.string().uuid(),
          bankTransactionId: z.string().uuid().optional(),
        },
      },
      async ({ businessProfileId, stripePayoutDbId, bankTransactionId }) =>
        this.call("confirm_stripe_payout", businessProfileId, "billing.confirmStripePayout", { businessProfileId, stripePayoutDbId, bankTransactionId }),
    );

    // MCP "prompt" (distinct from tools - a reusable workflow template a
    // client can surface directly to the user, e.g. as a slash command in
    // Claude Desktop) for the OCR -> add_expense_invoice workflow. Doesn't
    // do any OCR itself - it never sees the document - it just tells the
    // calling model exactly which fields to extract and how to call
    // add_expense_invoice, since that tool's own description can't carry
    // this much step-by-step guidance without bloating every tools/list
    // response. businessProfileId is optional: if the client doesn't know
    // it yet, the returned message tells the model to call
    // list_business_profiles first.
    this.server.registerPrompt(
      "add_expense_from_document",
      {
        title: "Add expense from a receipt/invoice image",
        description:
          "Walks the model through reading a receipt, invoice, or expense document (already attached to the " +
          "conversation, e.g. an image or PDF) and recording it in ksiegai as a cost/expense invoice via " +
          "add_expense_invoice. Requires a connection with draft_write or full_post tier.",
        argsSchema: {
          businessProfileId: z.string().uuid().optional().describe("If already known - otherwise the model will call list_business_profiles first"),
        },
      },
      async ({ businessProfileId }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                "Read the receipt/invoice/expense document attached to this conversation and record it in " +
                "ksiegai as a cost/expense invoice. Steps:\n\n" +
                "1. " +
                (businessProfileId
                  ? `Use businessProfileId ${businessProfileId}.`
                  : "Call list_business_profiles to get the businessProfileId - if the connection covers more than one business, ask the user which one.") +
                "\n" +
                "2. Read the document yourself (you have vision - this MCP server does no OCR) and extract: " +
                "supplier name, supplier NIP if shown, issue date, due date if shown, currency, and each line " +
                "item (name, quantity if shown, unit price if shown, VAT rate as a percent - use vatExempt:true " +
                "instead of a rate for VAT-exempt items, and net/vat/gross totals if the document shows them " +
                "explicitly rather than computing them yourself).\n" +
                "3. Call add_expense_invoice with those fields. Do not guess or invent any value the document " +
                "doesn't actually show - leave optional fields out instead.\n" +
                "4. The invoice always lands as needs_review, pending acceptance - it is never auto-posted to " +
                "the ledger. Tell the user it's saved and awaiting their review in ksiegai, and mention the " +
                "extracted supplier name and gross total so they can sanity-check it at a glance.\n" +
                "5. If the document is illegible, ambiguous, or missing required fields (supplier name, issue " +
                "date, at least one line item), say so instead of guessing - do not call add_expense_invoice " +
                "with fabricated data.",
            },
          },
        ],
      }),
    );
  }
}
