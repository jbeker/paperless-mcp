import assert from "node:assert/strict";
import { test } from "node:test";
import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { convertDocsWithNames } from "./documentEnhancer";
import { PaperlessAPI } from "./PaperlessAPI";
import { DocumentsResponse } from "./types";
import { createDocument, createPaperlessApiMock } from "../test/mocks/paperlessApi";

interface LookupPage {
  next?: string | null;
  results: Array<Record<string, unknown>>;
}

function createLookupApi(pages: Record<string, LookupPage>): PaperlessAPI {
  return {
    request: async (path: string) => {
      const page = pages[path];
      if (!page) return { count: 0, next: null, results: [] };
      return { count: page.results.length, next: page.next ?? null, results: page.results };
    },
  } as unknown as PaperlessAPI;
}

const LARGE_DOCUMENT_COUNT = 709;
const MAX_RESPONSE_SIZE_BYTES = 2000;

function getTextContent(result: CallToolResult): string {
  const item = result.content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected text content");
  }
  return item.text;
}

test("convertDocsWithNames omits `all` and keeps paginated JSON shape", async () => {
  const docsResponse: DocumentsResponse = {
    count: 2,
    next: null,
    previous: null,
    all: [1, 2],
    results: [createDocument(), createDocument({ id: 2, title: "Document 2" })],
  };

  const result = await convertDocsWithNames(docsResponse, createPaperlessApiMock());
  const parsed = JSON.parse(getTextContent(result));

  assert.ok(!("all" in parsed));
  assert.deepEqual(parsed.results.map((doc: { id: number }) => doc.id), [1, 2]);
  assert.ok(!("content" in parsed.results[0]));
});

test("convertDocsWithNames keeps responses small when source has large `all` arrays", async () => {
  const docsResponse: DocumentsResponse = {
    count: LARGE_DOCUMENT_COUNT,
    next: "http://localhost:8000/api/documents/?page=2",
    previous: null,
    all: Array.from({ length: LARGE_DOCUMENT_COUNT }, (_, index) => index + 1),
    results: [
      createDocument({
        id: 123,
        title: "Large all payload case",
        content: "x".repeat(2700),
      }),
    ],
  };

  const result = await convertDocsWithNames(docsResponse, createPaperlessApiMock());
  const responseText = getTextContent(result);

  assert.ok(responseText.length < MAX_RESPONSE_SIZE_BYTES);
  const parsed = JSON.parse(responseText);
  assert.ok(!("all" in parsed));
  assert.ok(!("content" in parsed.results[0]));
});

test("convertDocsWithNames returns paginated JSON for empty multi-document results", async () => {
  const docsResponse: DocumentsResponse = {
    count: 0,
    next: null,
    previous: null,
    all: [],
    results: [],
  };

  const result = await convertDocsWithNames(docsResponse, createPaperlessApiMock());
  const parsed = JSON.parse(getTextContent(result));

  assert.deepEqual(parsed, {
    count: 0,
    next: null,
    previous: null,
    results: [],
  });
});

test("resolves names for entities beyond the first page of lookup results", async () => {
  const api = createLookupApi({
    "/correspondents/?page_size=1000": {
      next: "http://paperless.local/api/correspondents/?page=2&page_size=1000",
      results: [{ id: 1, name: "First Page Corp" }],
    },
    "/correspondents/?page=2&page_size=1000": {
      results: [{ id: 3, name: "American Express" }],
    },
  });

  const result = await convertDocsWithNames(
    createDocument({ correspondent: 3 }),
    api
  );
  const parsed = JSON.parse((result.content[0] as { text: string }).text);

  assert.deepEqual(parsed.correspondent, { id: 3, name: "American Express" });
});

test("enriches owner with username and storage_path with name", async () => {
  const api = createLookupApi({
    "/users/?page_size=1000": {
      results: [{ id: 4, username: "jeb-tlb" }],
    },
    "/storage_paths/?page_size=1000": {
      results: [{ id: 2, name: "Archive/Bills" }],
    },
  });

  const result = await convertDocsWithNames(
    createDocument({ owner: 4, storage_path: 2 }),
    api
  );
  const parsed = JSON.parse((result.content[0] as { text: string }).text);

  assert.deepEqual(parsed.owner, { id: 4, name: "jeb-tlb" });
  assert.deepEqual(parsed.storage_path, { id: 2, name: "Archive/Bills" });
});

test("degrades owner to a null name when listing users is forbidden", async () => {
  const api = {
    request: async (path: string) => {
      if (path.startsWith("/users/")) {
        throw new Error("HTTP error! status: 403");
      }
      return { count: 0, next: null, results: [] };
    },
  } as unknown as PaperlessAPI;

  const result = await convertDocsWithNames(createDocument({ owner: 4 }), api);
  const parsed = JSON.parse((result.content[0] as { text: string }).text);

  assert.deepEqual(parsed.owner, { id: 4, name: null });
});

test("resolves entities created after the label cache was first populated", async () => {
  // The document type does not exist during the first convert (which fetches
  // twice: initial load + one refetch on miss) and is created before the second.
  let documentTypeFetches = 0;
  const api = {
    request: async (path: string) => {
      if (path.startsWith("/document_types/")) {
        documentTypeFetches++;
        const results =
          documentTypeFetches <= 2 ? [] : [{ id: 37, name: "Menu" }];
        return { count: results.length, next: null, results };
      }
      return { count: 0, next: null, results: [] };
    },
  } as unknown as PaperlessAPI;

  const first = await convertDocsWithNames(
    createDocument({ document_type: 37 }),
    api
  );
  const firstParsed = JSON.parse((first.content[0] as { text: string }).text);
  assert.deepEqual(firstParsed.document_type, { id: 37, name: null });
  assert.equal(documentTypeFetches, 2);

  const second = await convertDocsWithNames(
    createDocument({ document_type: 37 }),
    api
  );
  const secondParsed = JSON.parse((second.content[0] as { text: string }).text);
  assert.deepEqual(secondParsed.document_type, { id: 37, name: "Menu" });
  assert.equal(documentTypeFetches, 3);
});
