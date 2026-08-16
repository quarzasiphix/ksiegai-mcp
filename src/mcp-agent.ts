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
          "List the ksiegai business profile this connection is authorized for (id, name, entity type, tax " +
          "regime, VAT-exempt status). Each MCP connection is scoped to exactly one business at creation time " +
          "(Ustawienia -> Połącz AI (MCP)) - call this first to get its businessProfileId, required by every " +
          "other tool.",
        inputSchema: {},
      },
      async () => {
        // Bespoke, not routed through this.call(): this is the one tool
        // that structurally has no businessProfileId to declare up front
        // (its whole job is to reveal it) - it exchanges for
        // authorizedBusinessProfileId itself and filters core.init's
        // result down to just that one business, so a connection scoped
        // to business A never leaks the names/NIPs of the user's OTHER
        // businesses even though the underlying session JWT's RLS access
        // spans all of them.
        if (!this.props?.mcpTokenHash) {
          return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
        }
        let accessToken: string;
        let authorizedBusinessProfileId: string;
        try {
          const exchanged = await authenticateMcpCall(this.env, this.props.mcpTokenHash, "list_business_profiles");
          accessToken = exchanged.accessToken;
          authorizedBusinessProfileId = exchanged.authorizedBusinessProfileId;
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
          const parsed = result as { businessProfiles?: any[] };
          const profiles = (parsed.businessProfiles || [])
            .filter((p: any) => p.id === authorizedBusinessProfileId)
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
          items: z.array(expenseItemSchema).min(1),
        },
      },
      async (params) => this.call("add_expense_invoice", params.businessProfileId, "invoices.createExpense", params),
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
          "status (imported/needs_review/matched/posted/etc), and amounts.",
        inputSchema: {
          businessProfileId: z.string().uuid().describe("This connection's business profile - not forwarded to the bank query itself, only used to authorize the call"),
          accountId: z.string().uuid(),
        },
      },
      async ({ businessProfileId, accountId }) => this.callBank("list_bank_transactions", businessProfileId, "list-transactions", { accountId }),
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
                  : "Call list_business_profiles to get the businessProfileId (there's exactly one for this connection).") +
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
