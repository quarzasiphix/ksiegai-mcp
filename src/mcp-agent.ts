import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { McpProps } from "./auth";
import { callWorkspace } from "./gateway-client";

/**
 * First real tool, chosen deliberately: `accounting.listChartAccounts`
 * already exists end-to-end (gateway -> ksiegai-workspace -> RLS-scoped
 * Postgres read) with zero new backend work, so it proves the whole chain
 * — MCP tool -> this Worker -> Service Binding -> gateway -> edge function
 * -> RLS — before any new read/write tools get added.
 */
export class KsiegaiMcp extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: "ksiegai-accounting", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "get_chart_of_accounts",
      {
        description: "List the chart of accounts (COA) for a ksiegai business profile the caller has access to.",
        inputSchema: {
          businessProfileId: z.string().uuid(),
          activeOnly: z.boolean().optional(),
        },
      },
      async ({ businessProfileId, activeOnly }) => {
        if (!this.props?.supabaseAccessToken) {
          return { content: [{ type: "text", text: "Not authenticated." }], isError: true };
        }
        try {
          const result = await callWorkspace(this.env, this.props.supabaseAccessToken, "accounting.listChartAccounts", {
            businessProfileId,
            activeOnly,
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    );
  }
}
