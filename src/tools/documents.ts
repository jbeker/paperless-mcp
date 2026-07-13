import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { convertDocsWithNames } from "../api/documentEnhancer";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { arrayNotEmpty, objectNotEmpty } from "./utils/empty";
import {
  BuildDocumentQueryArgs,
  buildDocumentQueryString,
  LIST_DOCUMENTS_ARGS_SHAPE,
  QUERY_DOCUMENTS_ARGS_SHAPE,
  SEARCH_DOCUMENTS_ARGS_SHAPE,
} from "./utils/documentQuery";
import { DESTRUCTIVE, DESTRUCTIVE_BULK, READ_ONLY, UPDATE } from "./utils/annotations";
import { withErrorHandling } from "./utils/middlewares";
import { validateCustomFields } from "./utils/monetary";
import {
  EntityRef,
  entityRef,
  entityRefDescription,
  getEntityLabelMap,
  resolveDocumentQueryRefs,
  resolveEntityId,
  resolveEntityIdOrNull,
  resolveEntityIds,
  resolveUserGroupRefs,
} from "./utils/resolve";
import { resolveSelectCustomFieldValues } from "./utils/selectFields";
import { CUSTOM_FIELD_VALUE_DESCRIPTION } from "./utils/descriptions";
import {
  buildDocumentResourceUri,
  buildThumbnailResourceUri,
} from "./utils/resourceUri";

export type BulkCustomFieldValue = string | number | boolean | number[] | null;

export type BulkCustomFieldUpdate = {
  field: number;
  value: BulkCustomFieldValue;
};

export type BulkCustomFieldParameters = {
  add_custom_fields?: Record<string, BulkCustomFieldValue>;
  remove_custom_fields?: number[];
};

/**
 * Builds Paperless-NGX bulk edit parameters from base parameters plus optional
 * custom field updates.
 *
 * Paperless-NGX expects custom field bulk updates as an `add_custom_fields`
 * record keyed by custom field id. `addCustomFields` is accepted as an array for
 * the MCP tool schema and transformed into that id-to-value record while
 * preserving supported value types, including `number[]` document links and
 * `null` resets. Passing an empty `addCustomFields` array intentionally produces
 * an empty `add_custom_fields` record.
 *
 * When `includeCustomFieldDefaults` is true, the function also initializes
 * `add_custom_fields` and `remove_custom_fields` with empty defaults using
 * nullish coalescing (`??=`). This keeps the `modify_custom_fields` method's
 * payload shape acceptable to Paperless even when no field values are supplied.
 *
 * @param parameters - Base bulk edit parameters to include in the result.
 * @param addCustomFields - Optional custom field updates to map by field id.
 * @param includeCustomFieldDefaults - Whether to include empty custom field
 * defaults required by `modify_custom_fields`.
 * @returns The merged API parameters with custom field updates transformed into
 * Paperless-NGX's `add_custom_fields` record shape.
 */
export function buildBulkEditParameters<T extends Record<string, unknown>>(
  parameters: T,
  addCustomFields?: BulkCustomFieldUpdate[],
  includeCustomFieldDefaults = false,
  includeTagDefaults = false
): T & BulkCustomFieldParameters {
  const apiParameters: T & BulkCustomFieldParameters = {
    ...parameters,
  };

  if (addCustomFields) {
    apiParameters.add_custom_fields = Object.fromEntries(
      addCustomFields.map((customField) => [
        String(customField.field),
        customField.value,
      ])
    );
  }

  if (includeCustomFieldDefaults) {
    apiParameters.add_custom_fields ??= {};
    apiParameters.remove_custom_fields ??= [];
  }

  if (includeTagDefaults) {
    (apiParameters as Record<string, unknown>).add_tags ??= [];
    (apiParameters as Record<string, unknown>).remove_tags ??= [];
  }

  return apiParameters;
}

async function executeDocumentQuery(
  api: PaperlessAPI,
  args: BuildDocumentQueryArgs
) {
  const resolvedArgs = await resolveDocumentQueryRefs(api, args);
  const docsResponse = await api.getDocuments(
    buildDocumentQueryString(resolvedArgs)
  );
  return convertDocsWithNames(docsResponse, api);
}

interface BulkPermissionsArg {
  owner?: EntityRef | null;
  set_permissions?: {
    view: { users: EntityRef[]; groups: EntityRef[] };
    change: { users: EntityRef[]; groups: EntityRef[] };
  };
  merge?: boolean;
}

async function resolveBulkPermissions(
  api: PaperlessAPI,
  permissions: BulkPermissionsArg | undefined
) {
  if (!permissions) return undefined;
  const [owner, view, change] = await Promise.all([
    resolveEntityIdOrNull(api, "user", permissions.owner),
    permissions.set_permissions
      ? resolveUserGroupRefs(api, permissions.set_permissions.view)
      : undefined,
    permissions.set_permissions
      ? resolveUserGroupRefs(api, permissions.set_permissions.change)
      : undefined,
  ]);
  return {
    ...(owner !== undefined ? { owner } : {}),
    ...(view && change
      ? {
          set_permissions: {
            view: { users: view.users ?? [], groups: view.groups ?? [] },
            change: { users: change.users ?? [], groups: change.groups ?? [] },
          },
        }
      : {}),
    ...(permissions.merge !== undefined ? { merge: permissions.merge } : {}),
  };
}

export function registerDocumentTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "bulk_edit_documents",
    "Perform bulk operations on multiple documents. Entity references (correspondent, document type, tags, storage path, custom fields, owner, permission users/groups) accept numeric IDs or exact names. Note: 'remove_tag' removes a tag from specific documents (tag remains in system), while 'delete_tag' permanently deletes a tag from the entire system. ⚠️ WARNING: 'delete' method permanently deletes documents and requires confirmation.",
    {
      documents: z.array(z.number()),
      method: z.enum([
        "set_correspondent",
        "set_document_type",
        "set_storage_path",
        "add_tag",
        "remove_tag",
        "modify_tags",
        "modify_custom_fields",
        "delete",
        "reprocess",
        "set_permissions",
        "merge",
        "split",
        "rotate",
        "delete_pages",
      ]),
      correspondent: entityRef()
        .optional()
        .describe(entityRefDescription("correspondent")),
      document_type: entityRef()
        .optional()
        .describe(entityRefDescription("document_type")),
      storage_path: entityRef()
        .optional()
        .describe(entityRefDescription("storage_path")),
      tag: entityRef().optional().describe(entityRefDescription("tag")),
      add_tags: z
        .array(entityRef().describe(entityRefDescription("tag")))
        .optional()
        .transform(arrayNotEmpty),
      remove_tags: z
        .array(entityRef().describe(entityRefDescription("tag")))
        .optional()
        .transform(arrayNotEmpty),
      add_custom_fields: z
        .array(
          z.object({
            field: entityRef().describe(entityRefDescription("custom_field")),
            value: z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.number()),
              z.null(),
            ]).describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .transform(arrayNotEmpty),
      remove_custom_fields: z
        .array(entityRef().describe(entityRefDescription("custom_field")))
        .optional()
        .transform(arrayNotEmpty),
      permissions: z
        .object({
          owner: entityRef()
            .nullable()
            .optional()
            .describe(entityRefDescription("user", "Owner")),
          set_permissions: z
            .object({
              view: z.object({
                users: z.array(
                  entityRef().describe(entityRefDescription("user"))
                ),
                groups: z.array(
                  entityRef().describe(entityRefDescription("group"))
                ),
              }),
              change: z.object({
                users: z.array(
                  entityRef().describe(entityRefDescription("user"))
                ),
                groups: z.array(
                  entityRef().describe(entityRefDescription("group"))
                ),
              }),
            })
            .optional(),
          merge: z.boolean().optional(),
        })
        .optional()
        .transform(objectNotEmpty),
      metadata_document_id: z.number().optional(),
      delete_originals: z.boolean().optional(),
      pages: z.string().optional(),
      degrees: z.number().optional(),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Must be true when method is 'delete' to confirm destructive operation"
        ),
    },
    DESTRUCTIVE_BULK,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (args.method === "delete" && !args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      const {
        documents,
        method,
        add_custom_fields,
        confirm,
        correspondent: correspondentRef,
        document_type: documentTypeRef,
        storage_path: storagePathRef,
        tag: tagRef,
        add_tags: addTagsRef,
        remove_tags: removeTagsRef,
        remove_custom_fields: removeCustomFieldsRef,
        permissions: permissionsRef,
        ...passthrough
      } = args;

      const [
        correspondent,
        document_type,
        storage_path,
        tag,
        add_tags,
        remove_tags,
        remove_custom_fields,
        addCustomFieldsResolved,
        permissions,
      ] = await Promise.all([
        correspondentRef === undefined
          ? undefined
          : resolveEntityId(api, "correspondent", correspondentRef),
        documentTypeRef === undefined
          ? undefined
          : resolveEntityId(api, "document_type", documentTypeRef),
        storagePathRef === undefined
          ? undefined
          : resolveEntityId(api, "storage_path", storagePathRef),
        tagRef === undefined ? undefined : resolveEntityId(api, "tag", tagRef),
        addTagsRef ? resolveEntityIds(api, "tag", addTagsRef) : undefined,
        removeTagsRef ? resolveEntityIds(api, "tag", removeTagsRef) : undefined,
        removeCustomFieldsRef
          ? resolveEntityIds(api, "custom_field", removeCustomFieldsRef)
          : undefined,
        add_custom_fields
          ? Promise.all(
              add_custom_fields.map(async (cf) => ({
                ...cf,
                field: await resolveEntityId(api, "custom_field", cf.field),
              }))
            )
          : undefined,
        resolveBulkPermissions(api, permissionsRef),
      ]);

      const parameters = {
        ...passthrough,
        ...(correspondent !== undefined ? { correspondent } : {}),
        ...(document_type !== undefined ? { document_type } : {}),
        ...(storage_path !== undefined ? { storage_path } : {}),
        ...(tag !== undefined ? { tag } : {}),
        ...(add_tags !== undefined ? { add_tags } : {}),
        ...(remove_tags !== undefined ? { remove_tags } : {}),
        ...(remove_custom_fields !== undefined ? { remove_custom_fields } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
      };

      validateCustomFields(addCustomFieldsResolved);
      const resolvedCustomFields = await resolveSelectCustomFieldValues(
        api,
        addCustomFieldsResolved,
        "stored"
      );

      const response = await api.bulkEditDocuments(
        documents,
        method,
        method === "delete"
          ? {}
          : buildBulkEditParameters(
              parameters,
              resolvedCustomFields,
              method === "modify_custom_fields",
              method === "modify_tags"
            )
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ result: response.result || response }),
          },
        ],
      };
    })
  );

  server.tool(
    "list_documents",
    "List and filter documents with pagination and common Paperless filters such as title search, correspondent, document type, tag, storage path, creation date, archive serial number, and simple custom field filters. Use 'query_documents' for full-text query, structured custom field conditions, or advanced documented /api/documents/ query parameters. The correspondent, document_type, tag, and storage_path filters accept numeric IDs or exact names; unknown or ambiguous names return an error listing candidates. Note: Document content is excluded from results by default. Use 'get_document_content' when you need the document text.",
    LIST_DOCUMENTS_ARGS_SHAPE,
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      return executeDocumentQuery(api, args);
    })
  );

  server.tool(
    "query_documents",
    "Query documents using the full-text query engine plus structured Paperless filters. Use this for complex filtering, custom field conditions, or any documented /api/documents/ query parameters that are not exposed as first-class arguments. Prefer the dedicated top-level arguments where available. custom_field_query supports [field_name_or_id, operator, value] leaves or ['AND'|'OR', [clause1, clause2]] groups. Note: Document content is excluded from results by default. Use 'get_document_content' when you need the document text.",
    QUERY_DOCUMENTS_ARGS_SHAPE,
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      return executeDocumentQuery(api, args);
    })
  );

  server.tool(
    "get_document",
    "Get a specific document by ID with full details including correspondent, document type, tags, and custom fields. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      id: z.number(),
    },
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      return convertDocsWithNames(doc, api);
    })
  );

  server.tool(
    "get_document_content",
    "Get the text content of a specific document by ID. Use this when you need to read or analyze the actual document text.",
    {
      id: z.number(),
    },
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: doc.id,
              title: doc.title,
              content: doc.content,
            }),
          },
        ],
      };
    })
  );

  server.tool(
    "search_documents",
    "Deprecated compatibility wrapper for full-text document search. Use 'query_documents' with the 'query' argument for new integrations. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    SEARCH_DOCUMENTS_ARGS_SHAPE,
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      return executeDocumentQuery(api, args);
    })
  );

  server.tool(
    "download_document",
    "Download a document file by ID. Returns a paperless:// resource URI; read the resource to fetch the file content.",
    {
      id: z.number().int().positive(),
      original: z.boolean().optional(),
    },
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const uri = buildDocumentResourceUri(args.id, {
        original: args.original,
      });
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri,
              // MCP SDK 1.11 embedded resources require text or blob. Keep the
              // existing resource-shaped tool result while making resources/read
              // the canonical place for the large binary payload.
              text: "",
              mimeType: "application/octet-stream",
            },
          },
        ],
      };
    })
  );

  server.tool(
    "get_document_thumbnail",
    "Get a document thumbnail (image preview) by ID. Returns a paperless:// resource URI; read the resource to fetch the image content.",
    {
      id: z.number().int().positive(),
    },
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: buildThumbnailResourceUri(args.id),
              // See download_document above: the binary thumbnail is fetched
              // lazily through resources/read instead of embedded here.
              text: "",
              mimeType: "image/webp",
            },
          },
        ],
      };
    })
  );

  server.tool(
    "update_document",
    "Update a specific document with new values. This tool allows you to modify any document field including title, correspondent, document type, storage path, tags, custom fields, and more. Correspondent, document type, storage path, tags, owner, and custom field references accept numeric IDs or exact names. Only the fields you specify will be updated.",
    {
      id: z.number().describe("The ID of the document to update"),
      title: z
        .string()
        .max(128)
        .optional()
        .describe("The new title for the document (max 128 characters)"),
      correspondent: entityRef()
        .nullable()
        .optional()
        .describe(entityRefDescription("correspondent", "Correspondent to assign")),
      document_type: entityRef()
        .nullable()
        .optional()
        .describe(entityRefDescription("document_type", "Document type to assign")),
      storage_path: entityRef()
        .nullable()
        .optional()
        .describe(entityRefDescription("storage_path", "Storage path to assign")),
      tags: z
        .array(entityRef().describe(entityRefDescription("tag")))
        .optional()
        .describe("Tags to assign to the document (numeric IDs or exact names)"),
      content: z
        .string()
        .optional()
        .describe("The raw text content of the document (used for searching)"),
      created: z
        .string()
        .optional()
        .describe("The creation date in YYYY-MM-DD format"),
      archive_serial_number: z
        .number()
        .optional()
        .describe("The archive serial number (0-4294967295)"),
      owner: entityRef()
        .nullable()
        .optional()
        .describe(entityRefDescription("user", "Owner of the document")),
      custom_fields: z
        .array(
          z.object({
            field: entityRef().describe(entityRefDescription("custom_field")),
            value: z
              .union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.number()),
                z.null(),
              ])
              .describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .describe("Array of custom field values to assign"),
    },
    UPDATE,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const {
        id,
        correspondent: correspondentRef,
        document_type: documentTypeRef,
        storage_path: storagePathRef,
        tags: tagsRef,
        owner: ownerRef,
        custom_fields: customFieldsRef,
        ...updateData
      } = args;

      const [correspondent, document_type, storage_path, tags, owner, custom_fields] =
        await Promise.all([
          resolveEntityIdOrNull(api, "correspondent", correspondentRef),
          resolveEntityIdOrNull(api, "document_type", documentTypeRef),
          resolveEntityIdOrNull(api, "storage_path", storagePathRef),
          tagsRef ? resolveEntityIds(api, "tag", tagsRef) : undefined,
          resolveEntityIdOrNull(api, "user", ownerRef),
          customFieldsRef
            ? Promise.all(
                customFieldsRef.map(async (cf) => ({
                  ...cf,
                  field: await resolveEntityId(api, "custom_field", cf.field),
                }))
              )
            : undefined,
        ]);

      validateCustomFields(custom_fields);
      const resolvedCustomFields = await resolveSelectCustomFieldValues(
        api,
        custom_fields,
        "index"
      );

      const response = await api.updateDocument(id, {
        ...updateData,
        ...(correspondent !== undefined ? { correspondent } : {}),
        ...(document_type !== undefined ? { document_type } : {}),
        ...(storage_path !== undefined ? { storage_path } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(resolvedCustomFields !== undefined
          ? { custom_fields: resolvedCustomFields }
          : {}),
      });

      return convertDocsWithNames(response, api);
    })
  );

  server.tool(
    "get_document_suggestions",
    "Get Paperless's machine-learning suggestions for a document: likely correspondents, tags, document types, storage paths (each as {id, name}), and detected dates. Useful when classifying or filing a document.",
    {
      id: z.number().describe("The ID of the document to get suggestions for"),
    },
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const [suggestions, tagNames, correspondentNames, documentTypeNames, storagePathNames] =
        await Promise.all([
          api.getDocumentSuggestions(args.id),
          getEntityLabelMap(api, "tag"),
          getEntityLabelMap(api, "correspondent"),
          getEntityLabelMap(api, "document_type"),
          getEntityLabelMap(api, "storage_path"),
        ]);
      const named = (ids: number[], names: Map<number, string>) =>
        ids.map((id) => ({ id, name: names.get(id) ?? String(id) }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              correspondents: named(suggestions.correspondents, correspondentNames),
              tags: named(suggestions.tags, tagNames),
              document_types: named(suggestions.document_types, documentTypeNames),
              storage_paths: named(suggestions.storage_paths, storagePathNames),
              dates: suggestions.dates,
            }),
          },
        ],
      };
    })
  );

  server.tool(
    "get_document_metadata",
    "Get file-level metadata for a document: checksums, file sizes, MIME type, original and archive filenames, embedded file metadata, and detected language.",
    {
      id: z.number().describe("The ID of the document"),
    },
    READ_ONLY,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const metadata = await api.getDocumentMetadata(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(metadata) }],
      };
    })
  );

  server.tool(
    "get_next_asn",
    "Get the next available archive serial number (ASN). Use when assigning archive_serial_number to a document.",
    {},
    READ_ONLY,
    withErrorHandling(async () => {
      if (!api) throw new Error("Please configure API connection first");
      const nextAsn = await api.getNextAsn();
      return {
        content: [{ type: "text", text: JSON.stringify({ next_asn: nextAsn }) }],
      };
    })
  );

  server.tool(
    "delete_document",
    "⚠️ DESTRUCTIVE: Delete a document. The document is moved to the trash, where it can be restored with 'restore_from_trash' until the trash retention period expires or the trash is emptied.",
    {
      id: z.number().describe("The ID of the document to delete"),
      confirm: z
        .boolean()
        .describe("Must be true to confirm this destructive operation"),
    },
    DESTRUCTIVE,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (!args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      await api.deleteDocument(args.id);
      return {
        content: [
          { type: "text", text: JSON.stringify({ status: "deleted" }) },
        ],
      };
    })
  );
}
