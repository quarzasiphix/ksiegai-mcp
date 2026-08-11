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
      "list_invoices",
      {
        description: "List invoices (income and expense) for this connection's business profile, optionally within a date range.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          startDate: z.string().optional().describe("ISO date, YYYY-MM-DD"),
          endDate: z.string().optional().describe("ISO date, YYYY-MM-DD"),
        },
      },
      async ({ businessProfileId, startDate, endDate }) =>
        this.call("list_invoices", businessProfileId, "invoices.listInvoices", { businessProfileId, startDate, endDate }),
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
  }
}
