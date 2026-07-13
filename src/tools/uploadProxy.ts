import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { withErrorHandling } from "./utils/middlewares";
import {
  entityRef,
  entityRefDescription,
  resolveEntityId,
  resolveEntityIds,
} from "./utils/resolve";

export function registerUploadProxyTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "request_upload_url",
    "Request a short-lived, single-use URL for uploading a document to Paperless-NGX. " +
      "This is the only way to upload documents: file content never passes through the MCP protocol, " +
      "so uploads of any size work. Call this tool with the desired metadata, then POST the file to " +
      "the returned upload_url from wherever the file lives, e.g. " +
      "curl -sf -X POST -F 'document=@FILE.pdf' '<upload_url>'. " +
      "The URL expires (default 15 minutes) and is consumed by the first upload attempt. " +
      "The document will be owned by the user whose token this MCP connection uses. " +
      "Correspondent, document type, and tags accept numeric IDs or exact names.",
    {
      title: z.string().optional().describe("Document title set at upload"),
      correspondent: entityRef()
        .optional()
        .describe(entityRefDescription("correspondent")),
      document_type: entityRef()
        .optional()
        .describe(entityRefDescription("document_type")),
      tags: z
        .array(entityRef().describe(entityRefDescription("tag")))
        .optional(),
      created: z.string().optional().describe("Document creation date, YYYY-MM-DD"),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Upload size limit in bytes. Default 104857600 (100 MB); the proxy enforces its own ceiling."),
      ttl_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("URL lifetime in seconds. Default 900; capped at 3600."),
    },
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");

      const proxyUrl = process.env.UPLOAD_PROXY_URL;
      if (!proxyUrl) {
        throw new Error(
          "The upload proxy is not configured. Set the UPLOAD_PROXY_URL environment variable " +
            "to the base URL of a paperless-upload-proxy instance (see proxy/README.md) to enable document uploads."
        );
      }

      const {
        correspondent: correspondentRef,
        document_type: documentTypeRef,
        tags: tagsRef,
        ...rest
      } = args;
      const [correspondent, document_type, tags] = await Promise.all([
        correspondentRef === undefined
          ? undefined
          : resolveEntityId(api, "correspondent", correspondentRef),
        documentTypeRef === undefined
          ? undefined
          : resolveEntityId(api, "document_type", documentTypeRef),
        tagsRef ? resolveEntityIds(api, "tag", tagsRef) : undefined,
      ]);

      const response = await api.mintUploadUrl(proxyUrl, {
        ...rest,
        ...(correspondent !== undefined ? { correspondent } : {}),
        ...(document_type !== undefined ? { document_type } : {}),
        ...(tags !== undefined ? { tags } : {}),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );
}
