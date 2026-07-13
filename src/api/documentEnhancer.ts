import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { getEntityLabelMap } from "../tools/utils/resolve";
import { PaperlessAPI } from "./PaperlessAPI";
import { Document, DocumentsResponse } from "./types";
import { NamedItem } from "./utils";

interface CustomField {
  field: number;
  name: string;
  value: string | number | boolean | object | null;
}

export interface EnhancedDocument
  extends Omit<
    Document,
    | "correspondent"
    | "document_type"
    | "tags"
    | "custom_fields"
    | "storage_path"
    | "owner"
  > {
  correspondent: NamedItem | null;
  document_type: NamedItem | null;
  tags: NamedItem[];
  custom_fields: CustomField[];
  storage_path: NamedItem | null;
  owner: NamedItem | null;
}

export async function convertDocsWithNames(
  document: Document,
  api: PaperlessAPI
): Promise<CallToolResult>;
export async function convertDocsWithNames(
  documentsResponse: DocumentsResponse,
  api: PaperlessAPI
): Promise<CallToolResult>;
export async function convertDocsWithNames(
  input: Document | DocumentsResponse,
  api: PaperlessAPI
): Promise<CallToolResult> {
  if ("results" in input) {
    const { all, results, ...paginationMeta } = input;
    const enhancedResults = await enhanceDocumentsArray(results || [], api);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...paginationMeta,
            results: enhancedResults,
          }),
        },
      ],
    };
  }

  if (!input) {
    return {
      content: [
        {
          type: "text",
          text: "No document found",
        },
      ],
    };
  }
  const [enhanced] = await enhanceDocumentsArray([input], api);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(enhanced),
      },
    ],
  };
}

async function enhanceDocumentsArray(
  documents: Document[],
  api: PaperlessAPI
): Promise<Omit<EnhancedDocument, 'content'>[]> {
  if (!documents?.length) {
    return [];
  }

  // The resolver's label maps fetch with page_size=1000 and follow pagination;
  // fetching the bare list endpoints here truncated lookups to the server's
  // default first page, rendering names as stringified IDs.
  const [
    correspondentMap,
    documentTypeMap,
    tagMap,
    customFieldMap,
    storagePathMap,
    userMap,
  ] = await Promise.all([
    getEntityLabelMap(api, "correspondent"),
    getEntityLabelMap(api, "document_type"),
    getEntityLabelMap(api, "tag"),
    getEntityLabelMap(api, "custom_field"),
    getEntityLabelMap(api, "storage_path"),
    // Non-admin tokens may not be allowed to list users; degrade to bare IDs.
    getEntityLabelMap(api, "user").catch(() => new Map<number, string>()),
  ]);

  return documents
    .map((doc) => {
      const { content, ...docWithoutContent } = doc;
      return docWithoutContent;
    })
    .map((doc) => ({
      ...doc,
      correspondent: doc.correspondent
        ? {
            id: doc.correspondent,
            name:
              correspondentMap.get(doc.correspondent) ||
              String(doc.correspondent),
          }
        : null,
      document_type: doc.document_type
        ? {
            id: doc.document_type,
            name:
              documentTypeMap.get(doc.document_type) || String(doc.document_type),
          }
        : null,
      storage_path: doc.storage_path
        ? {
            id: doc.storage_path,
            name:
              storagePathMap.get(doc.storage_path) || String(doc.storage_path),
          }
        : null,
      owner: doc.owner
        ? {
            id: doc.owner,
            name: userMap.get(doc.owner) || String(doc.owner),
          }
        : null,
      tags: Array.isArray(doc.tags)
        ? doc.tags.map((tagId) => ({
            id: tagId,
            name: tagMap.get(tagId) || String(tagId),
          }))
        : doc.tags,
      custom_fields: Array.isArray(doc.custom_fields)
        ? doc.custom_fields.map((field) => ({
            field: field.field,
            name: customFieldMap.get(field.field) || String(field.field),
            value: field.value,
          }))
        : doc.custom_fields,
    }));
}
