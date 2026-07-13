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
import { registerUserTools } from "./users";

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

function createTransportPair() {
  const clientTransport = new TestTransport();
  const serverTransport = new TestTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  return { clientTransport, serverTransport };
}

function parseToolText(result: CallToolResult) {
  const item = result.content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected text tool response");
  }
  return JSON.parse(item.text);
}

async function withUserClient(
  api: PaperlessAPI,
  run: (client: Client) => Promise<void>
) {
  const server = new McpServer({ name: "paperless-user-test", version: "1.0.0" });
  registerUserTools(server, api);

  const client = new Client({
    name: "paperless-user-test-client",
    version: "1.0.0",
  });
  const { clientTransport, serverTransport } = createTransportPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("who_am_i combines ui_settings, the user record, and group names", async () => {
  const api = {
    getUiSettings: async () => ({
      user: { id: 3, username: "jeremy" },
    }),
    getUser: async (id: number) => {
      assert.equal(id, 3);
      return {
        id: 3,
        username: "jeremy",
        email: "jeremy@example.com",
        first_name: "Jeremy",
        last_name: "Beker",
        is_staff: true,
        is_active: true,
        is_superuser: false,
        groups: [1, 2],
        inherited_permissions: [],
        is_mfa_enabled: false,
      };
    },
    getGroups: async (query?: string) => {
      assert.equal(query, "id__in=1,2");
      return {
        count: 2,
        next: null,
        previous: null,
        all: [],
        results: [
          { id: 1, name: "family", permissions: [] },
          { id: 2, name: "admins", permissions: [] },
        ],
      };
    },
  } as unknown as PaperlessAPI;

  await withUserClient(api, async (client) => {
    const result = (await client.callTool({
      name: "who_am_i",
      arguments: {},
    })) as CallToolResult;
    assert.ok(!result.isError, JSON.stringify(result.content));
    const identity = parseToolText(result);
    assert.deepEqual(identity, {
      id: 3,
      username: "jeremy",
      first_name: "Jeremy",
      last_name: "Beker",
      email: "jeremy@example.com",
      groups: [
        { id: 1, name: "family" },
        { id: 2, name: "admins" },
      ],
      is_staff: true,
      is_superuser: false,
      is_active: true,
    });
  });
});

test("who_am_i falls back to profile data when the users endpoint is forbidden", async () => {
  const api = {
    getUiSettings: async () => ({
      user: { id: 7, username: "limited", is_staff: false },
    }),
    getUser: async () => {
      throw new Error("HTTP error! status: 403");
    },
    getProfile: async () => ({
      email: "limited@example.com",
      first_name: "Lim",
      last_name: "Ited",
    }),
    getGroups: async () => {
      throw new Error("HTTP error! status: 403");
    },
  } as unknown as PaperlessAPI;

  await withUserClient(api, async (client) => {
    const result = (await client.callTool({
      name: "who_am_i",
      arguments: {},
    })) as CallToolResult;
    assert.ok(!result.isError, JSON.stringify(result.content));
    const identity = parseToolText(result);
    assert.equal(identity.id, 7);
    assert.equal(identity.username, "limited");
    assert.equal(identity.email, "limited@example.com");
    assert.equal(identity.first_name, "Lim");
    assert.equal(identity.is_staff, false);
    assert.deepEqual(identity.groups, []);
  });
});

test("who_am_i errors clearly when ui_settings has no user info", async () => {
  const api = {
    getUiSettings: async () => ({ settings: {} }),
  } as unknown as PaperlessAPI;

  await withUserClient(api, async (client) => {
    const result = (await client.callTool({
      name: "who_am_i",
      arguments: {},
    })) as CallToolResult;
    assert.ok(result.isError);
    const message = parseToolText(result)?.error ?? "";
    assert.match(message, /Could not determine the current user/);
  });
});

test("list_users passes username filters through to the API", async () => {
  const queries: Array<string | undefined> = [];
  const api = {
    getUsers: async (query?: string) => {
      queries.push(query);
      return {
        count: 1,
        next: null,
        previous: null,
        all: [],
        results: [{ id: 3, username: "jeremy" }],
      };
    },
  } as unknown as PaperlessAPI;

  await withUserClient(api, async (client) => {
    const result = (await client.callTool({
      name: "list_users",
      arguments: { username__icontains: "jer", page_size: 10 },
    })) as CallToolResult;
    assert.ok(!result.isError);
    const body = parseToolText(result);
    assert.equal(body.results[0].username, "jeremy");
  });

  assert.equal(queries.length, 1);
  const params = new URLSearchParams(queries[0]);
  assert.equal(params.get("username__icontains"), "jer");
  assert.equal(params.get("page_size"), "10");
});
