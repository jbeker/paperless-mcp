import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperlessAPI } from "../../api/PaperlessAPI";
import {
  resolveDocumentQueryRefs,
  resolveEntityId,
  resolveEntityIdOrNull,
  resolveEntityIds,
} from "./resolve";

interface Page {
  next?: string | null;
  results: Array<Record<string, unknown>>;
}

function createResolverApi(pagesByPath: Record<string, Page>) {
  const requests: string[] = [];
  const api = {
    request: async (path: string) => {
      requests.push(path);
      const page = pagesByPath[path];
      if (!page) throw new Error(`unexpected request: ${path}`);
      return { count: page.results.length, next: page.next ?? null, results: page.results };
    },
  } as unknown as PaperlessAPI;
  return { api, requests };
}

function tagPages(results: Array<Record<string, unknown>>) {
  return { "/tags/?page_size=1000": { results } };
}

test("numeric refs pass through without any API request", async () => {
  const { api, requests } = createResolverApi({});
  assert.equal(await resolveEntityId(api, "tag", 42), 42);
  assert.equal(requests.length, 0);
});

test("null and undefined pass through resolveEntityIdOrNull", async () => {
  const { api, requests } = createResolverApi({});
  assert.equal(await resolveEntityIdOrNull(api, "tag", null), null);
  assert.equal(await resolveEntityIdOrNull(api, "tag", undefined), undefined);
  assert.equal(requests.length, 0);
});

test("resolves a name case-insensitively with trimming", async () => {
  const { api } = createResolverApi(
    tagPages([
      { id: 1, name: "Receipts" },
      { id: 2, name: "Taxes" },
    ])
  );
  assert.equal(await resolveEntityId(api, "tag", "  rEcEiPtS "), 1);
});

test("follows pagination across pages", async () => {
  const { api, requests } = createResolverApi({
    "/tags/?page_size=1000": {
      next: "http://paperless.local/api/tags/?page=2&page_size=1000",
      results: [{ id: 1, name: "Alpha" }],
    },
    "/tags/?page=2&page_size=1000": {
      results: [{ id: 2, name: "Beta" }],
    },
  });
  assert.equal(await resolveEntityId(api, "tag", "beta"), 2);
  assert.deepEqual(requests, [
    "/tags/?page_size=1000",
    "/tags/?page=2&page_size=1000",
  ]);
});

test("unknown name errors with near-miss suggestions", async () => {
  const { api } = createResolverApi(
    tagPages([
      { id: 12, name: "Receipts" },
      { id: 33, name: "Recipes" },
    ])
  );
  await assert.rejects(
    () => resolveEntityId(api, "tag", "Receipt"),
    (error: Error) => {
      assert.match(error.message, /No tag found matching name "Receipt"/);
      assert.match(error.message, /"Receipts" \(id 12\)/);
      return true;
    }
  );
});

test("unknown name with no near-misses lists existing names", async () => {
  const { api } = createResolverApi(
    tagPages([
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ])
  );
  await assert.rejects(
    () => resolveEntityId(api, "tag", "zzz"),
    (error: Error) => {
      assert.match(error.message, /Existing tags include: "Alpha", "Beta"/);
      return true;
    }
  );
});

test("ambiguous name errors listing all matches", async () => {
  const { api } = createResolverApi(
    tagPages([
      { id: 3, name: "Invoice" },
      { id: 9, name: "INVOICE" },
    ])
  );
  await assert.rejects(
    () => resolveEntityId(api, "tag", "invoice"),
    (error: Error) => {
      assert.match(error.message, /Ambiguous tag name "invoice"/);
      assert.match(error.message, /"Invoice" \(id 3\)/);
      assert.match(error.message, /"INVOICE" \(id 9\)/);
      assert.match(error.message, /Pass the numeric ID/);
      return true;
    }
  );
});

test("second resolution of the same kind uses the cache", async () => {
  const { api, requests } = createResolverApi(
    tagPages([
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ])
  );
  await resolveEntityId(api, "tag", "Alpha");
  await resolveEntityId(api, "tag", "Beta");
  assert.equal(requests.length, 1);
});

test("a miss triggers exactly one refetch, finding newly created entities", async () => {
  let call = 0;
  const requests: string[] = [];
  const api = {
    request: async (path: string) => {
      requests.push(path);
      call++;
      const results =
        call === 1
          ? [{ id: 1, name: "Alpha" }]
          : [
              { id: 1, name: "Alpha" },
              { id: 2, name: "Fresh" },
            ];
      return { count: results.length, next: null, results };
    },
  } as unknown as PaperlessAPI;

  assert.equal(await resolveEntityId(api, "tag", "Alpha"), 1);
  assert.equal(await resolveEntityId(api, "tag", "Fresh"), 2);
  assert.equal(requests.length, 2);
});

test("a definitive miss refetches only once before erroring", async () => {
  const { api, requests } = createResolverApi(
    tagPages([{ id: 1, name: "Alpha" }])
  );
  await assert.rejects(() => resolveEntityId(api, "tag", "Nope"));
  assert.equal(requests.length, 2);
});

test("resolveEntityIds preserves order and mixes numbers with names", async () => {
  const { api, requests } = createResolverApi(
    tagPages([
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ])
  );
  assert.deepEqual(
    await resolveEntityIds(api, "tag", ["Beta", 7, "Alpha", "Beta"]),
    [2, 7, 1, 2]
  );
  assert.equal(requests.length, 1);
});

test("users resolve by username", async () => {
  const { api } = createResolverApi({
    "/users/?page_size=1000": {
      results: [
        { id: 3, username: "jeremy", first_name: "Jeremy" },
        { id: 4, username: "alice" },
      ],
    },
  });
  assert.equal(await resolveEntityId(api, "user", "Jeremy"), 3);
  await assert.rejects(
    () => resolveEntityId(api, "user", "bob"),
    /No user found matching username "bob"/
  );
});

test("mail accounts resolve by name from the full list", async () => {
  const { api } = createResolverApi({
    "/mail_accounts/?page_size=1000": {
      results: [{ id: 5, name: "Family Gmail" }],
    },
  });
  assert.equal(await resolveEntityId(api, "mail_account", "family gmail"), 5);
});

test("resolveDocumentQueryRefs resolves only the entity filters", async () => {
  const { api } = createResolverApi({
    "/tags/?page_size=1000": { results: [{ id: 5, name: "Receipts" }] },
    "/correspondents/?page_size=1000": { results: [{ id: 3, name: "Utility Co" }] },
  });
  const resolved = await resolveDocumentQueryRefs(api, {
    tag: "Receipts",
    correspondent: "utility co",
    document_type: 4,
    page: 2,
    ordering: "-created",
  });
  assert.deepEqual(resolved, {
    tag: 5,
    correspondent: 3,
    document_type: 4,
    page: 2,
    ordering: "-created",
  });
});

test("failed lookup fetches are not cached", async () => {
  let call = 0;
  const api = {
    request: async () => {
      call++;
      if (call === 1) throw new Error("HTTP error! status: 500");
      return { count: 1, next: null, results: [{ id: 1, name: "Alpha" }] };
    },
  } as unknown as PaperlessAPI;

  await assert.rejects(() => resolveEntityId(api, "tag", "Alpha"), /500/);
  assert.equal(await resolveEntityId(api, "tag", "Alpha"), 1);
});
