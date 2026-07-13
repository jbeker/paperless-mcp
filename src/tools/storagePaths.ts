import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { enhanceMatchingAlgorithmArray } from "../api/utils";
import { READ_ONLY } from "./utils/annotations";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

export function registerStoragePathTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "list_storage_paths",
    "List storage paths with pagination and name filtering. Storage paths determine where Paperless files documents on disk; use their names or IDs with 'set_storage_path' in bulk_edit_documents or the 'storage_path' field of update_document.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
      name__icontains: z.string().optional(),
      name__iexact: z.string().optional(),
      ordering: z.string().optional(),
    },
    READ_ONLY,
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const response = await api.getStoragePaths(queryString || undefined);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...response,
              results: enhanceMatchingAlgorithmArray(response.results || []),
            }),
          },
        ],
      };
    })
  );
}
