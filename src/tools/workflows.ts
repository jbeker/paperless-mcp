import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { WorkflowAction, WorkflowTrigger } from "../api/types";
import {
  CREATE,
  DESTRUCTIVE,
  READ_ONLY,
  UPDATE,
} from "./utils/annotations";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";
import {
  entityRef,
  entityRefDescription,
  resolveEntityId,
  resolveEntityIdOrNull,
  resolveEntityIds,
  ResolvableKind,
  EntityRef,
} from "./utils/resolve";

const TRIGGER_TYPE_DESCRIPTION =
  "Trigger type: 1=Consumption Started, 2=Document Added, 3=Document Updated, 4=Scheduled";
const SOURCES_DESCRIPTION =
  "Consumption sources the trigger applies to: 1=Consume Folder, 2=API Upload, 3=Mail Fetch, 4=Web UI. Default [1,2,3].";
const TRIGGER_MATCHING_DESCRIPTION =
  "Matching algorithm: 0=None, 1=Any word, 2=All words, 3=Exact match, 4=Regular expression, 5=Fuzzy word";
const ACTION_TYPE_DESCRIPTION =
  "Action type: 1=Assignment, 2=Removal, 3=Email, 4=Webhook";

const tagRefArray = () =>
  z.array(entityRef().describe(entityRefDescription("tag"))).optional();

const workflowTriggerSchema = z.object({
  id: z.number().int().nullable().optional(),
  sources: z
    .array(z.number().int().min(1).max(4))
    .optional()
    .describe(SOURCES_DESCRIPTION),
  type: z.number().int().min(1).max(4).describe(TRIGGER_TYPE_DESCRIPTION),
  filter_path: z.string().nullable().optional(),
  filter_filename: z.string().nullable().optional(),
  filter_mailrule: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("mail_rule")),
  matching_algorithm: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe(TRIGGER_MATCHING_DESCRIPTION),
  match: z.string().optional(),
  is_insensitive: z.boolean().optional(),
  filter_has_tags: tagRefArray(),
  filter_has_all_tags: tagRefArray(),
  filter_has_not_tags: tagRefArray(),
  filter_custom_field_query: z.string().nullable().optional(),
  filter_has_not_correspondents: z
    .array(entityRef().describe(entityRefDescription("correspondent")))
    .optional(),
  filter_has_not_document_types: z
    .array(entityRef().describe(entityRefDescription("document_type")))
    .optional(),
  filter_has_not_storage_paths: z
    .array(entityRef().describe(entityRefDescription("storage_path")))
    .optional(),
  filter_has_correspondent: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("correspondent")),
  filter_has_document_type: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("document_type")),
  filter_has_storage_path: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("storage_path")),
  schedule_offset_days: z.number().int().optional(),
  schedule_is_recurring: z.boolean().optional(),
  schedule_recurring_interval_days: z.number().int().min(1).optional(),
  schedule_date_field: z
    .enum(["added", "created", "modified", "custom_field"])
    .optional(),
  schedule_date_custom_field: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("custom_field")),
});

const workflowActionSchema = z.object({
  id: z.number().int().nullable().optional(),
  type: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe(ACTION_TYPE_DESCRIPTION),
  assign_title: z
    .string()
    .nullable()
    .optional()
    .describe("Title to assign; supports Jinja2 templating"),
  assign_tags: z
    .array(entityRef().nullable().describe(entityRefDescription("tag")))
    .optional(),
  assign_correspondent: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("correspondent")),
  assign_document_type: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("document_type")),
  assign_storage_path: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("storage_path")),
  assign_owner: entityRef()
    .nullable()
    .optional()
    .describe(entityRefDescription("user", "Owner")),
  assign_view_users: z
    .array(entityRef().describe(entityRefDescription("user")))
    .optional(),
  assign_view_groups: z
    .array(entityRef().describe(entityRefDescription("group")))
    .optional(),
  assign_change_users: z
    .array(entityRef().describe(entityRefDescription("user")))
    .optional(),
  assign_change_groups: z
    .array(entityRef().describe(entityRefDescription("group")))
    .optional(),
  assign_custom_fields: z
    .array(entityRef().describe(entityRefDescription("custom_field")))
    .optional(),
  assign_custom_fields_values: z
    .record(z.unknown())
    .nullable()
    .optional()
    .describe(
      "Custom field values keyed by numeric custom field ID (names are NOT resolved here)"
    ),
  remove_all_tags: z.boolean().optional(),
  remove_tags: tagRefArray(),
  remove_all_correspondents: z.boolean().optional(),
  remove_correspondents: z
    .array(entityRef().describe(entityRefDescription("correspondent")))
    .optional(),
  remove_all_document_types: z.boolean().optional(),
  remove_document_types: z
    .array(entityRef().describe(entityRefDescription("document_type")))
    .optional(),
  remove_all_storage_paths: z.boolean().optional(),
  remove_storage_paths: z
    .array(entityRef().describe(entityRefDescription("storage_path")))
    .optional(),
  remove_custom_fields: z
    .array(entityRef().describe(entityRefDescription("custom_field")))
    .optional(),
  remove_all_custom_fields: z.boolean().optional(),
  remove_all_owners: z.boolean().optional(),
  remove_owners: z
    .array(entityRef().describe(entityRefDescription("user")))
    .optional(),
  remove_all_permissions: z.boolean().optional(),
  remove_view_users: z
    .array(entityRef().describe(entityRefDescription("user")))
    .optional(),
  remove_view_groups: z
    .array(entityRef().describe(entityRefDescription("group")))
    .optional(),
  remove_change_users: z
    .array(entityRef().describe(entityRefDescription("user")))
    .optional(),
  remove_change_groups: z
    .array(entityRef().describe(entityRefDescription("group")))
    .optional(),
  email: z
    .object({
      subject: z.string(),
      body: z.string(),
      to: z.string().describe("Comma-separated email addresses"),
      include_document: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  webhook: z
    .object({
      url: z.string(),
      use_params: z.boolean().optional(),
      as_json: z.boolean().optional(),
      params: z.record(z.unknown()).nullable().optional(),
      body: z.string().nullable().optional(),
      headers: z.record(z.unknown()).nullable().optional(),
      include_document: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

type WorkflowTriggerInput = z.infer<typeof workflowTriggerSchema>;
type WorkflowActionInput = z.infer<typeof workflowActionSchema>;

async function resolveWorkflowTrigger(
  api: PaperlessAPI,
  trigger: WorkflowTriggerInput
): Promise<WorkflowTrigger> {
  const {
    filter_mailrule,
    filter_has_tags,
    filter_has_all_tags,
    filter_has_not_tags,
    filter_has_not_correspondents,
    filter_has_not_document_types,
    filter_has_not_storage_paths,
    filter_has_correspondent,
    filter_has_document_type,
    filter_has_storage_path,
    schedule_date_custom_field,
    ...rest
  } = trigger;

  const resolved: WorkflowTrigger = { ...rest };
  const assignArray = async (
    key: keyof WorkflowTrigger,
    kind: ResolvableKind,
    refs: EntityRef[] | undefined
  ) => {
    if (refs !== undefined) {
      (resolved[key] as number[]) = await resolveEntityIds(api, kind, refs);
    }
  };
  const assignSingle = async (
    key: keyof WorkflowTrigger,
    kind: ResolvableKind,
    ref: EntityRef | null | undefined
  ) => {
    if (ref !== undefined) {
      (resolved[key] as number | null) = await resolveEntityIdOrNull(
        api,
        kind,
        ref
      ) as number | null;
    }
  };

  await Promise.all([
    assignArray("filter_has_tags", "tag", filter_has_tags),
    assignArray("filter_has_all_tags", "tag", filter_has_all_tags),
    assignArray("filter_has_not_tags", "tag", filter_has_not_tags),
    assignArray(
      "filter_has_not_correspondents",
      "correspondent",
      filter_has_not_correspondents
    ),
    assignArray(
      "filter_has_not_document_types",
      "document_type",
      filter_has_not_document_types
    ),
    assignArray(
      "filter_has_not_storage_paths",
      "storage_path",
      filter_has_not_storage_paths
    ),
    assignSingle("filter_has_correspondent", "correspondent", filter_has_correspondent),
    assignSingle("filter_has_document_type", "document_type", filter_has_document_type),
    assignSingle("filter_has_storage_path", "storage_path", filter_has_storage_path),
    assignSingle("filter_mailrule", "mail_rule", filter_mailrule),
    assignSingle("schedule_date_custom_field", "custom_field", schedule_date_custom_field),
  ]);

  return resolved;
}

async function resolveWorkflowAction(
  api: PaperlessAPI,
  action: WorkflowActionInput
): Promise<WorkflowAction> {
  const {
    assign_tags,
    assign_correspondent,
    assign_document_type,
    assign_storage_path,
    assign_owner,
    assign_view_users,
    assign_view_groups,
    assign_change_users,
    assign_change_groups,
    assign_custom_fields,
    remove_tags,
    remove_correspondents,
    remove_document_types,
    remove_storage_paths,
    remove_custom_fields,
    remove_owners,
    remove_view_users,
    remove_view_groups,
    remove_change_users,
    remove_change_groups,
    ...rest
  } = action;

  const resolved: WorkflowAction = { ...rest };
  const assignArray = async (
    key: keyof WorkflowAction,
    kind: ResolvableKind,
    refs: EntityRef[] | undefined
  ) => {
    if (refs !== undefined) {
      (resolved[key] as number[]) = await resolveEntityIds(api, kind, refs);
    }
  };
  const assignSingle = async (
    key: keyof WorkflowAction,
    kind: ResolvableKind,
    ref: EntityRef | null | undefined
  ) => {
    if (ref !== undefined) {
      (resolved[key] as number | null) = await resolveEntityIdOrNull(
        api,
        kind,
        ref
      ) as number | null;
    }
  };

  await Promise.all([
    assign_tags !== undefined
      ? Promise.all(
          assign_tags.map((tag) =>
            tag === null ? null : resolveEntityId(api, "tag", tag)
          )
        ).then((tags) => {
          resolved.assign_tags = tags;
        })
      : undefined,
    assignSingle("assign_correspondent", "correspondent", assign_correspondent),
    assignSingle("assign_document_type", "document_type", assign_document_type),
    assignSingle("assign_storage_path", "storage_path", assign_storage_path),
    assignSingle("assign_owner", "user", assign_owner),
    assignArray("assign_view_users", "user", assign_view_users),
    assignArray("assign_view_groups", "group", assign_view_groups),
    assignArray("assign_change_users", "user", assign_change_users),
    assignArray("assign_change_groups", "group", assign_change_groups),
    assignArray("assign_custom_fields", "custom_field", assign_custom_fields),
    assignArray("remove_tags", "tag", remove_tags),
    assignArray("remove_correspondents", "correspondent", remove_correspondents),
    assignArray("remove_document_types", "document_type", remove_document_types),
    assignArray("remove_storage_paths", "storage_path", remove_storage_paths),
    assignArray("remove_custom_fields", "custom_field", remove_custom_fields),
    assignArray("remove_owners", "user", remove_owners),
    assignArray("remove_view_users", "user", remove_view_users),
    assignArray("remove_view_groups", "group", remove_view_groups),
    assignArray("remove_change_users", "user", remove_change_users),
    assignArray("remove_change_groups", "group", remove_change_groups),
  ]);

  return resolved;
}

async function resolveWorkflowPayload(
  api: PaperlessAPI,
  args: {
    triggers?: WorkflowTriggerInput[];
    actions?: WorkflowActionInput[];
  }
): Promise<{ triggers?: WorkflowTrigger[]; actions?: WorkflowAction[] }> {
  const [triggers, actions] = await Promise.all([
    args.triggers
      ? Promise.all(args.triggers.map((t) => resolveWorkflowTrigger(api, t)))
      : undefined,
    args.actions
      ? Promise.all(args.actions.map((a) => resolveWorkflowAction(api, a)))
      : undefined,
  ]);
  return {
    ...(triggers !== undefined ? { triggers } : {}),
    ...(actions !== undefined ? { actions } : {}),
  };
}

export function registerWorkflowTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "list_workflows",
    "List Paperless workflows with their triggers and actions. Workflows automatically assign or remove metadata, send emails, or call webhooks when documents are consumed, added, updated, or on a schedule.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
    },
    READ_ONLY,
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const response = await api.getWorkflows(queryString || undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.tool(
    "get_workflow",
    "Get one Paperless workflow by ID, including its triggers and actions.",
    { id: z.number().int() },
    READ_ONLY,
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");
      const workflow = await api.getWorkflow(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(workflow) }],
      };
    })
  );

  server.tool(
    "create_workflow",
    "Create a Paperless workflow. Triggers and actions are defined inline. Entity references in triggers/actions (tags, correspondents, document types, storage paths, custom fields, mail rules, users, groups) accept numeric IDs or exact names.",
    {
      name: z.string(),
      order: z.number().int().optional(),
      enabled: z.boolean().optional(),
      triggers: z.array(workflowTriggerSchema),
      actions: z.array(workflowActionSchema),
    },
    CREATE,
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");
      const { name, order, enabled, ...payload } = args;
      const resolved = await resolveWorkflowPayload(api, payload);
      const workflow = await api.createWorkflow({
        name,
        ...(order !== undefined ? { order } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        triggers: resolved.triggers ?? [],
        actions: resolved.actions ?? [],
      });
      return {
        content: [{ type: "text", text: JSON.stringify(workflow) }],
      };
    })
  );

  server.tool(
    "update_workflow",
    "Patch an existing Paperless workflow. Only supplied fields are changed, but 'triggers' and 'actions', when provided, REPLACE the full arrays (fetch the workflow first with get_workflow to modify existing entries). Entity references accept numeric IDs or exact names.",
    {
      id: z.number().int(),
      name: z.string().optional(),
      order: z.number().int().optional(),
      enabled: z.boolean().optional(),
      triggers: z.array(workflowTriggerSchema).optional(),
      actions: z.array(workflowActionSchema).optional(),
    },
    UPDATE,
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");
      const { id, name, order, enabled, ...payload } = args;
      const resolved = await resolveWorkflowPayload(api, payload);
      const workflow = await api.updateWorkflow(id, {
        ...(name !== undefined ? { name } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...resolved,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(workflow) }],
      };
    })
  );

  server.tool(
    "delete_workflow",
    "⚠️ DESTRUCTIVE: Permanently delete a Paperless workflow, including its triggers and actions. Documents already processed by the workflow are not affected.",
    {
      id: z.number().int(),
      confirm: z
        .boolean()
        .describe("Must be true to confirm this destructive operation"),
    },
    DESTRUCTIVE,
    withErrorHandling(async (args) => {
      if (!api) throw new Error("Please configure API connection first");
      if (!args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      await api.deleteWorkflow(args.id);
      return {
        content: [
          { type: "text", text: JSON.stringify({ status: "deleted" }) },
        ],
      };
    })
  );
}
