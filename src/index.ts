import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { PaperlessAPI } from "./api/PaperlessAPI";
import { registerCorrespondentTools } from "./tools/correspondents";
import { registerDocumentTools } from "./tools/documents";
import { registerDocumentTypeTools } from "./tools/documentTypes";
import { registerTagTools } from "./tools/tags";

// Simple CLI argument parsing
const args = process.argv.slice(2);
const useHttp = args.includes("--http");
const readOnly = args.includes("--read-only");
let port = 3000;
const portIndex = args.indexOf("--port");
if (portIndex !== -1 && args[portIndex + 1]) {
  const parsed = parseInt(args[portIndex + 1], 10);
  if (!isNaN(parsed)) port = parsed;
}
// Extract positional args (filter out flags and their values)
const flagsWithValues = new Set(["--port"]);
const flags = new Set(["--http", "--read-only"]);
const positionalArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (flagsWithValues.has(args[i])) {
    i++; // skip the flag's value
  } else if (!flags.has(args[i])) {
    positionalArgs.push(args[i]);
  }
}

async function main() {
  let baseUrl: string | undefined;
  let token: string | undefined;

  if (useHttp) {
    baseUrl = process.env.PAPERLESS_URL;
    token = process.env.API_KEY;
    if (!baseUrl || !token) {
      console.error(
        "When using --http, PAPERLESS_URL and API_KEY environment variables must be set."
      );
      process.exit(1);
    }
  } else {
    baseUrl = positionalArgs[0];
    token = positionalArgs[1];
    if (!baseUrl || !token) {
      console.error(
        "Usage: paperless-mcp <baseUrl> <token> [--http] [--port <port>] [--read-only]"
      );
      console.error(
        "Example: paperless-mcp http://localhost:8000 your-api-token --http --port 3000 --read-only"
      );
      console.error(
        "When using --http, PAPERLESS_URL and API_KEY environment variables must be set."
      );
      process.exit(1);
    }
  }

  // Initialize API client and server once
  const api = new PaperlessAPI(baseUrl, token);
  const server = new McpServer({ name: "paperless-ngx", version: "1.0.0" });
  if (readOnly) {
    console.error("Starting in read-only mode. Write operations are disabled.");
  }
  registerDocumentTools(server, api, readOnly);
  registerTagTools(server, api, readOnly);
  registerCorrespondentTools(server, api, readOnly);
  registerDocumentTypeTools(server, api, readOnly);

  if (useHttp) {
    const app = express();
    app.use(express.json());

    // Store transports for each session
    const sseTransports: Record<string, SSEServerTransport> = {};

    app.post("/mcp", async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    app.get("/mcp", async (req, res) => {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    app.delete("/mcp", async (req, res) => {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    app.get("/sse", async (req, res) => {
      console.log("SSE request received");
      try {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports[transport.sessionId] = transport;
        res.on("close", () => {
          delete sseTransports[transport.sessionId];
          transport.close();
        });
        await server.connect(transport);
      } catch (error) {
        console.error("Error handling SSE request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = sseTransports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send("No transport found for sessionId");
      }
    });

    app.listen(port, () => {
      console.log(
        `MCP Stateless Streamable HTTP Server listening on port ${port}`
      );
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((e) => console.error(e.message));
