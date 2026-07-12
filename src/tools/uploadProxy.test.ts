import assert from "node:assert/strict";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type {
  CallToolResult,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { registerUploadProxyTools } from "./uploadProxy";

const TEST_TOKEN = "unit-test-token";

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

async function withUploadProxyClient(run: (client: Client) => Promise<void>) {
  const api = new PaperlessAPI("http://paperless.invalid", TEST_TOKEN);
  const server = new McpServer({
    name: "paperless-upload-test",
    version: "1.0.0",
  });
  registerUploadProxyTools(server, api);

  const client = new Client({
    name: "paperless-upload-test-client",
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

interface ReceivedMint {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

const MINT_RESPONSE = {
  upload_url: "https://uploads.example.com/upload/abc123",
  expires_at: "2026-07-12T15:30:00Z",
  max_bytes: 104857600,
  curl_example:
    "curl -sf -X POST -F 'document=@FILE.pdf' 'https://uploads.example.com/upload/abc123'",
};

describe("request_upload_url", () => {
  let fakeProxy: Server;
  let proxyUrl: string;
  let received: ReceivedMint | undefined;
  let respondWith: { status: number; body: unknown } = {
    status: 200,
    body: MINT_RESPONSE,
  };
  const originalProxyUrl = process.env.UPLOAD_PROXY_URL;

  before(async () => {
    fakeProxy = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          received = {
            method: req.method ?? "",
            url: req.url ?? "",
            authorization: req.headers["authorization"],
            contentType: req.headers["content-type"],
            body: JSON.parse(Buffer.concat(chunks).toString() || "null"),
          };
          res.writeHead(respondWith.status, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(respondWith.body));
        });
      }
    );
    await new Promise<void>((resolve) =>
      fakeProxy.listen(0, "127.0.0.1", resolve)
    );
    const address = fakeProxy.address() as AddressInfo;
    proxyUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => fakeProxy.close(resolve));
    if (originalProxyUrl === undefined) {
      delete process.env.UPLOAD_PROXY_URL;
    } else {
      process.env.UPLOAD_PROXY_URL = originalProxyUrl;
    }
  });

  afterEach(() => {
    received = undefined;
    respondWith = { status: 200, body: MINT_RESPONSE };
  });

  test("returns a configuration error when UPLOAD_PROXY_URL is unset", async () => {
    delete process.env.UPLOAD_PROXY_URL;
    await withUploadProxyClient(async (client) => {
      const result = (await client.callTool({
        name: "request_upload_url",
        arguments: {},
      })) as CallToolResult;
      assert.ok(result.isError, "expected an error result");
      const message = parseToolText(result)?.error ?? "";
      assert.match(message, /UPLOAD_PROXY_URL/);
      assert.match(message, /not configured/);
    });
  });

  test("mints against the proxy with the API token and returns the response verbatim", async () => {
    process.env.UPLOAD_PROXY_URL = proxyUrl;
    await withUploadProxyClient(async (client) => {
      const result = (await client.callTool({
        name: "request_upload_url",
        arguments: {
          title: "Test Doc",
          tags: [3, 7],
          correspondent: 2,
          max_bytes: 1024,
          ttl_seconds: 60,
        },
      })) as CallToolResult;
      assert.ok(!result.isError, JSON.stringify(result.content));
      assert.deepEqual(parseToolText(result), MINT_RESPONSE);
    });

    assert.ok(received, "fake proxy should have been called");
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/mint");
    assert.equal(received.authorization, `Token ${TEST_TOKEN}`);
    assert.match(received.contentType ?? "", /application\/json/);
    assert.deepEqual(received.body, {
      title: "Test Doc",
      tags: [3, 7],
      correspondent: 2,
      max_bytes: 1024,
      ttl_seconds: 60,
    });
  });

  test("strips a trailing slash from UPLOAD_PROXY_URL", async () => {
    process.env.UPLOAD_PROXY_URL = `${proxyUrl}/`;
    await withUploadProxyClient(async (client) => {
      const result = (await client.callTool({
        name: "request_upload_url",
        arguments: {},
      })) as CallToolResult;
      assert.ok(!result.isError, JSON.stringify(result.content));
    });
    assert.equal(received?.url, "/mint");
  });

  test("surfaces proxy error responses with status and message", async () => {
    process.env.UPLOAD_PROXY_URL = proxyUrl;
    respondWith = { status: 401, body: { error: "invalid Paperless token" } };
    await withUploadProxyClient(async (client) => {
      const result = (await client.callTool({
        name: "request_upload_url",
        arguments: {},
      })) as CallToolResult;
      assert.ok(result.isError, "expected an error result");
      const message = parseToolText(result)?.error ?? "";
      assert.match(message, /401/);
      assert.match(message, /invalid Paperless token/);
    });
  });

  test("reports an unreachable proxy without leaking the token", async () => {
    // Port 9 (discard) on localhost is not listening.
    process.env.UPLOAD_PROXY_URL = "http://127.0.0.1:9";
    await withUploadProxyClient(async (client) => {
      const result = (await client.callTool({
        name: "request_upload_url",
        arguments: {},
      })) as CallToolResult;
      assert.ok(result.isError, "expected an error result");
      const message = parseToolText(result)?.error ?? "";
      assert.match(message, /unreachable/);
      assert.ok(!message.includes(TEST_TOKEN), "token must not leak into errors");
    });
  });
});
