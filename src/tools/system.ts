import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import {
  DESTRUCTIVE_BULK,
  READ_ONLY,
  UPDATE,
} from "./utils/annotations";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

export function registerSystemTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "list_tasks",
    "List background tasks (document consumption, classifier training, etc.). Useful for checking whether an upload has finished processing: filter by status or by the Celery task_id returned when a document was posted. Returns a plain array, not a paginated response.",
    {
      acknowledged: z.boolean().optional(),
      status: z
        .enum([
          "FAILURE",
          "PENDING",
          "RECEIVED",
          "RETRY",
          "REVOKED",
          "STARTED",
          "SUCCESS",
        ])
        .optional(),
      task_id: z.string().optional().describe("Filter by Celery task UUID"),
      task_name: z
        .enum(["check_sanity", "consume_file", "index_optimize", "train_classifier"])
        .optional(),
      type: z.enum(["auto_task", "manual_task", "scheduled_task"]).optional(),
      ordering: z.string().optional(),
    },
    READ_ONLY,
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const tasks = await api.getTasks(queryString || undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(tasks) }],
      };
    })
  );

  server.tool(
    "get_task",
    "Get a background task by its numeric ID (the 'id' field from list_tasks, not the Celery UUID — use list_tasks with the task_id filter to look up by UUID).",
    { id: z.number().int() },
    READ_ONLY,
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");
      const task = await api.getTask(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(task) }],
      };
    })
  );

  server.tool(
    "acknowledge_tasks",
    "Acknowledge (dismiss) task notifications by their numeric task IDs. Does not cancel or delete the tasks themselves.",
    {
      tasks: z.array(z.number().int()).describe("Numeric task IDs to acknowledge"),
    },
    UPDATE,
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");
      const result = await api.acknowledgeTasks(args.tasks);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    })
  );

  server.tool(
    "get_statistics",
    "Get statistics for the current user: document counts, inbox count, tag/correspondent/document type totals, character counts, and file type breakdown.",
    {},
    READ_ONLY,
    withErrorHandling(async () => {
      if (!api) throw new Error("Please configure API connection first");
      const statistics = await api.getStatistics();
      return {
        content: [{ type: "text", text: JSON.stringify(statistics) }],
      };
    })
  );

  server.tool(
    "get_system_status",
    "Get Paperless system health: version, install type, storage usage, and the state of the database, task queue, search index, classifier, and sanity checks.",
    {},
    READ_ONLY,
    withErrorHandling(async () => {
      if (!api) throw new Error("Please configure API connection first");
      const status = await api.getSystemStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
      };
    })
  );

  server.tool(
    "list_trash",
    "List documents currently in the trash (soft-deleted). Documents in trash can be restored with 'restore_from_trash' or permanently deleted with 'empty_trash'.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
    },
    READ_ONLY,
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const trash = await api.getTrash(queryString || undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(trash) }],
      };
    })
  );

  server.tool(
    "restore_from_trash",
    "Restore soft-deleted documents from the trash back into Paperless.",
    {
      documents: z
        .array(z.number().int())
        .optional()
        .describe("Document IDs to restore. Omit to restore ALL documents in trash."),
    },
    UPDATE,
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const result = await api.editTrash({
        ...(args.documents !== undefined ? { documents: args.documents } : {}),
        action: "restore",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    })
  );

  server.tool(
    "empty_trash",
    "⚠️ DESTRUCTIVE: Permanently and irreversibly delete documents from the trash. If 'documents' is omitted, the ENTIRE trash is wiped. This cannot be undone.",
    {
      documents: z
        .array(z.number().int())
        .optional()
        .describe(
          "Document IDs to permanently delete from trash. ⚠️ OMITTING this PERMANENTLY DELETES EVERY document in the trash."
        ),
      confirm: z
        .boolean()
        .describe("Must be true to confirm this destructive operation"),
    },
    DESTRUCTIVE_BULK,
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");
      if (!args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      const result = await api.editTrash({
        ...(args.documents !== undefined ? { documents: args.documents } : {}),
        action: "empty",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    })
  );
}
