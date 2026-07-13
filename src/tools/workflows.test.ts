import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type {
  CallToolResult,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { WorkflowRequest } from "../api/types";
import { registerWorkflowTools } from "./workflows";

class TestTransport implements Transport {
  peer?: TestTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function parseToolText(result: CallToolResult) {
  const item = result.content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected text tool response");
  }
  return JSON.parse(item.text);
}

async function withWorkflowClient(
  api: PaperlessAPI,
  run: (client: Client) => Promise<void>
) {
  const server = new McpServer({
    name: "paperless-workflow-test",
    version: "1.0.0",
  });
  registerWorkflowTools(server, api);

  const client = new Client({
    name: "paperless-workflow-test-client",
    version: "1.0.0",
  });
  const clientTransport = new TestTransport();
  const serverTransport = new TestTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function createLookupRequest(
  lookups: Record<string, Array<Record<string, unknown>>>
) {
  return async (path: string) => {
    const results = lookups[path.split("?")[0]];
    if (!results) throw new Error(`unexpected lookup request: ${path}`);
    return { count: results.length, next: null, results };
  };
}

test("workflow tools are registered", async () => {
  await withWorkflowClient({} as PaperlessAPI, async (client) => {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
      "create_workflow",
      "delete_workflow",
      "get_workflow",
      "list_workflows",
      "update_workflow",
    ]);
  });
});

test("create_workflow resolves entity names in triggers and actions", async () => {
  const calls: WorkflowRequest[] = [];
  const api = {
    request: createLookupRequest({
      "/tags/": [{ id: 3, name: "Inbox" }],
      "/correspondents/": [{ id: 7, name: "ACME" }],
      "/users/": [{ id: 11, username: "alice" }],
    }),
    createWorkflow: async (data: WorkflowRequest) => {
      calls.push(data);
      return { id: 1, ...data };
    },
  } as unknown as PaperlessAPI;

  await withWorkflowClient(api, async (client) => {
    const result = (await client.callTool({
      name: "create_workflow",
      arguments: {
        name: "File invoices",
        triggers: [{ type: 2, filter_has_tags: ["Inbox", 9] }],
        actions: [
          {
            type: 1,
            assign_correspondent: "acme",
            assign_tags: ["Inbox"],
            assign_view_users: ["alice", 12],
          },
        ],
      },
    })) as CallToolResult;
    assert.ok(!result.isError, parseToolText(result)?.error);
  });

  assert.equal(calls.length, 1);
  const payload = calls[0];
  assert.equal(payload.name, "File invoices");
  assert.deepEqual(payload.triggers, [{ type: 2, filter_has_tags: [3, 9] }]);
  assert.deepEqual(payload.actions, [
    {
      type: 1,
      assign_correspondent: 7,
      assign_tags: [3],
      assign_view_users: [11, 12],
    },
  ]);
});

test("update_workflow sends only supplied fields with resolved actions", async () => {
  const calls: Array<[number, Partial<WorkflowRequest>]> = [];
  const api = {
    request: createLookupRequest({
      "/document_types/": [{ id: 4, name: "Invoice" }],
    }),
    updateWorkflow: async (id: number, data: Partial<WorkflowRequest>) => {
      calls.push([id, data]);
      return { id, name: "x", triggers: [], actions: [], ...data };
    },
  } as unknown as PaperlessAPI;

  await withWorkflowClient(api, async (client) => {
    const result = (await client.callTool({
      name: "update_workflow",
      arguments: {
        id: 5,
        enabled: false,
        actions: [{ type: 1, assign_document_type: "invoice" }],
      },
    })) as CallToolResult;
    assert.ok(!result.isError, parseToolText(result)?.error);
  });

  assert.deepEqual(calls, [
    [
      5,
      {
        enabled: false,
        actions: [{ type: 1, assign_document_type: 4 }],
      },
    ],
  ]);
});

test("delete_workflow requires confirmation", async () => {
  const deleted: number[] = [];
  const api = {
    deleteWorkflow: async (id: number) => {
      deleted.push(id);
    },
  } as unknown as PaperlessAPI;

  await withWorkflowClient(api, async (client) => {
    const denied = (await client.callTool({
      name: "delete_workflow",
      arguments: { id: 5, confirm: false },
    })) as CallToolResult;
    assert.ok(denied.isError);
    assert.match(parseToolText(denied)?.error ?? "", /Confirmation required/);
    assert.equal(deleted.length, 0);

    const confirmed = (await client.callTool({
      name: "delete_workflow",
      arguments: { id: 5, confirm: true },
    })) as CallToolResult;
    assert.ok(!confirmed.isError);
  });

  assert.deepEqual(deleted, [5]);
});
