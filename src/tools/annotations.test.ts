import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types";
import { createMcpServer } from "../server";

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

type Tier = "read" | "create" | "update" | "delete" | "delete_bulk";

const EXPECTED_TIERS: Record<string, Tier> = {
  list_documents: "read",
  query_documents: "read",
  search_documents: "read",
  get_document: "read",
  get_document_content: "read",
  download_document: "read",
  get_document_thumbnail: "read",
  list_correspondents: "read",
  get_correspondent: "read",
  list_document_types: "read",
  get_document_type: "read",
  list_tags: "read",
  list_custom_fields: "read",
  get_custom_field: "read",
  list_document_notes: "read",
  list_mail_accounts: "read",
  get_mail_account: "read",
  list_mail_rules: "read",
  get_mail_rule: "read",
  who_am_i: "read",
  list_users: "read",
  list_groups: "read",
  list_storage_paths: "read",
  create_correspondent: "create",
  create_document_type: "create",
  create_tag: "create",
  create_custom_field: "create",
  create_document_note: "create",
  create_mail_rule: "create",
  request_upload_url: "create",
  update_document: "update",
  update_correspondent: "update",
  update_document_type: "update",
  update_tag: "update",
  update_custom_field: "update",
  update_mail_rule: "update",
  delete_correspondent: "delete",
  delete_document_type: "delete",
  delete_tag: "delete",
  delete_custom_field: "delete",
  delete_document_note: "delete",
  delete_mail_rule: "delete",
  bulk_edit_documents: "delete_bulk",
  bulk_edit_correspondents: "delete_bulk",
  bulk_edit_document_types: "delete_bulk",
  bulk_edit_tags: "delete_bulk",
  bulk_edit_custom_fields: "delete_bulk",
  process_mail_account: "delete_bulk",
};

const TIER_HINTS: Record<
  Tier,
  { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
> = {
  read: { readOnlyHint: true },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  delete_bulk: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

test("every tool declares annotations matching its safety tier", async () => {
  const server = createMcpServer({
    baseUrl: "http://localhost:9",
    token: "test-token",
    version: "0.0.0",
    publicUrl: "http://localhost:9",
  });
  const client = new Client({ name: "annotations-test", version: "1.0.0" });
  const clientTransport = new TestTransport();
  const serverTransport = new TestTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      Object.keys(EXPECTED_TIERS).sort(),
      "tool list and EXPECTED_TIERS map are out of sync"
    );

    for (const tool of tools) {
      const annotations = tool.annotations;
      assert.ok(annotations, `${tool.name} has no annotations`);
      assert.equal(
        annotations.openWorldHint,
        false,
        `${tool.name} should declare openWorldHint: false`
      );

      const expected = TIER_HINTS[EXPECTED_TIERS[tool.name]];
      assert.equal(
        annotations.readOnlyHint,
        expected.readOnlyHint,
        `${tool.name} readOnlyHint`
      );
      if (!expected.readOnlyHint) {
        assert.equal(
          annotations.destructiveHint,
          expected.destructiveHint,
          `${tool.name} destructiveHint`
        );
        assert.equal(
          annotations.idempotentHint,
          expected.idempotentHint,
          `${tool.name} idempotentHint`
        );
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});
