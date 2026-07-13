import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import {
  getEntityLabelMap,
  ResolvableKind,
} from "../tools/utils/resolve";
import { PaperlessAPI } from "./PaperlessAPI";
import { Document, DocumentsResponse } from "./types";

/** name is null when the ID is not resolvable (deleted, or not visible to this token). */
export interface NamedRef {
  id: number;
  name: string | null;
}

interface CustomField {
  field: number;
  name: string | null;
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
  correspondent: NamedRef | null;
  document_type: NamedRef | null;
  tags: NamedRef[];
  custom_fields: CustomField[];
  storage_path: NamedRef | null;
  owner: NamedRef | null;
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

  const correspondentIds = new Set<number>();
  const documentTypeIds = new Set<number>();
  const tagIds = new Set<number>();
  const customFieldIds = new Set<number>();
  const storagePathIds = new Set<number>();
  const ownerIds = new Set<number>();
  for (const doc of documents) {
    if (doc.correspondent) correspondentIds.add(doc.correspondent);
    if (doc.document_type) documentTypeIds.add(doc.document_type);
    if (doc.storage_path) storagePathIds.add(doc.storage_path);
    if (doc.owner) ownerIds.add(doc.owner);
    if (Array.isArray(doc.tags)) doc.tags.forEach((id) => tagIds.add(id));
    if (Array.isArray(doc.custom_fields)) {
      doc.custom_fields.forEach((cf) => customFieldIds.add(cf.field));
    }
  }

  // The resolver's label maps fetch with page_size=1000, follow pagination,
  // and refetch once when a requested ID is missing from the cached table —
  // so names beyond the first page and entities created mid-session resolve.
  const labelMap = (kind: ResolvableKind, ids: Set<number>) =>
    ids.size === 0
      ? Promise.resolve(new Map<number, string>())
      : getEntityLabelMap(api, kind, ids);

  const [
    correspondentMap,
    documentTypeMap,
    tagMap,
    customFieldMap,
    storagePathMap,
    userMap,
  ] = await Promise.all([
    labelMap("correspondent", correspondentIds),
    labelMap("document_type", documentTypeIds),
    labelMap("tag", tagIds),
    labelMap("custom_field", customFieldIds),
    labelMap("storage_path", storagePathIds),
    // Non-admin tokens may not be allowed to list users; degrade to null names.
    labelMap("user", ownerIds).catch(() => new Map<number, string>()),
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
            name: correspondentMap.get(doc.correspondent) ?? null,
          }
        : null,
      document_type: doc.document_type
        ? {
            id: doc.document_type,
            name: documentTypeMap.get(doc.document_type) ?? null,
          }
        : null,
      storage_path: doc.storage_path
        ? {
            id: doc.storage_path,
            name: storagePathMap.get(doc.storage_path) ?? null,
          }
        : null,
      owner: doc.owner
        ? {
            id: doc.owner,
            name: userMap.get(doc.owner) ?? null,
          }
        : null,
      tags: Array.isArray(doc.tags)
        ? doc.tags.map((tagId) => ({
            id: tagId,
            name: tagMap.get(tagId) ?? null,
          }))
        : doc.tags,
      custom_fields: Array.isArray(doc.custom_fields)
        ? doc.custom_fields.map((field) => ({
            field: field.field,
            name: customFieldMap.get(field.field) ?? null,
            value: field.value,
          }))
        : doc.custom_fields,
    }));
}
