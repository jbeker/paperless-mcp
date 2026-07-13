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
import { TrashRequest } from "../api/types";
import { registerSystemTools } from "./system";

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

async function withSystemClient(
  api: PaperlessAPI,
  run: (client: Client) => Promise<void>
) {
  const server = new McpServer({ name: "paperless-system-test", version: "1.0.0" });
  registerSystemTools(server, api);

  const client = new Client({
    name: "paperless-system-test-client",
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

test("list_tasks passes filters through as query parameters", async () => {
  const queries: Array<string | undefined> = [];
  const api = {
    getTasks: async (query?: string) => {
      queries.push(query);
      return [{ id: 1, task_id: "abc", status: "SUCCESS" }];
    },
  } as unknown as PaperlessAPI;

  await withSystemClient(api, async (client) => {
    const result = (await client.callTool({
      name: "list_tasks",
      arguments: { status: "SUCCESS", task_name: "consume_file" },
    })) as CallToolResult;
    assert.ok(!result.isError);
    assert.equal(parseToolText(result)[0].task_id, "abc");
  });

  const params = new URLSearchParams(queries[0]);
  assert.equal(params.get("status"), "SUCCESS");
  assert.equal(params.get("task_name"), "consume_file");
});

test("acknowledge_tasks posts the task IDs and returns the result", async () => {
  const calls: number[][] = [];
  const api = {
    acknowledgeTasks: async (tasks: number[]) => {
      calls.push(tasks);
      return { result: tasks.length };
    },
  } as unknown as PaperlessAPI;

  await withSystemClient(api, async (client) => {
    const result = (await client.callTool({
      name: "acknowledge_tasks",
      arguments: { tasks: [1, 2] },
    })) as CallToolResult;
    assert.ok(!result.isError);
    assert.deepEqual(parseToolText(result), { result: 2 });
  });

  assert.deepEqual(calls, [[1, 2]]);
});

test("restore_from_trash posts a restore action with the document list", async () => {
  const calls: TrashRequest[] = [];
  const api = {
    editTrash: async (data: TrashRequest) => {
      calls.push(data);
      return { result: "OK" };
    },
  } as unknown as PaperlessAPI;

  await withSystemClient(api, async (client) => {
    const result = (await client.callTool({
      name: "restore_from_trash",
      arguments: { documents: [4, 5] },
    })) as CallToolResult;
    assert.ok(!result.isError);
  });

  assert.deepEqual(calls, [{ documents: [4, 5], action: "restore" }]);
});

test("empty_trash requires confirmation", async () => {
  const calls: TrashRequest[] = [];
  const api = {
    editTrash: async (data: TrashRequest) => {
      calls.push(data);
      return { result: "OK" };
    },
  } as unknown as PaperlessAPI;

  await withSystemClient(api, async (client) => {
    const denied = (await client.callTool({
      name: "empty_trash",
      arguments: { confirm: false },
    })) as CallToolResult;
    assert.ok(denied.isError, "expected an error without confirmation");
    assert.match(parseToolText(denied)?.error ?? "", /Confirmation required/);
    assert.equal(calls.length, 0);

    const confirmed = (await client.callTool({
      name: "empty_trash",
      arguments: { confirm: true },
    })) as CallToolResult;
    assert.ok(!confirmed.isError);
  });

  assert.deepEqual(calls, [{ action: "empty" }]);
  assert.ok(
    !("documents" in calls[0]),
    "omitted documents must not be sent as a key"
  );
});
