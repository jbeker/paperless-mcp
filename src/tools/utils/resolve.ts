import { z } from "zod";
import { PaperlessAPI } from "../../api/PaperlessAPI";
import { PaginationResponse } from "../../api/types";

/** A numeric ID (passed through) or a name to resolve (case-insensitive exact match). */
export type EntityRef = number | string;

export type ResolvableKind =
  | "tag"
  | "correspondent"
  | "document_type"
  | "storage_path"
  | "custom_field"
  | "user"
  | "group"
  | "mail_account"
  | "mail_rule";

interface KindConfig {
  endpoint: string;
  labelField: "name" | "username";
  singular: string;
}

const KIND_CONFIG: Record<ResolvableKind, KindConfig> = {
  tag: { endpoint: "/tags/", labelField: "name", singular: "tag" },
  correspondent: {
    endpoint: "/correspondents/",
    labelField: "name",
    singular: "correspondent",
  },
  document_type: {
    endpoint: "/document_types/",
    labelField: "name",
    singular: "document type",
  },
  storage_path: {
    endpoint: "/storage_paths/",
    labelField: "name",
    singular: "storage path",
  },
  custom_field: {
    endpoint: "/custom_fields/",
    labelField: "name",
    singular: "custom field",
  },
  user: { endpoint: "/users/", labelField: "username", singular: "user" },
  group: { endpoint: "/groups/", labelField: "name", singular: "group" },
  mail_account: {
    endpoint: "/mail_accounts/",
    labelField: "name",
    singular: "mail account",
  },
  mail_rule: {
    endpoint: "/mail_rules/",
    labelField: "name",
    singular: "mail rule",
  },
};

const MAX_PAGES = 10;
const MAX_SUGGESTIONS = 5;
const MAX_LISTED_NAMES = 10;

interface CacheEntry {
  id: number;
  label: string;
}

/**
 * Lookup tables keyed by API instance: HTTP mode constructs a new PaperlessAPI
 * per request, so entries live for one request; stdio mode caches for the
 * session. A miss triggers one refetch (see resolveOne), so entities created
 * mid-session resolve; upstream renames can leave a stale hit until restart.
 */
const cache = new WeakMap<
  PaperlessAPI,
  Map<ResolvableKind, Promise<CacheEntry[]>>
>();

export const entityRef = () => z.union([z.number().int(), z.string().min(1)]);

export function entityRefDescription(
  kind: ResolvableKind,
  noun?: string
): string {
  const label = KIND_CONFIG[kind].labelField === "username" ? "username" : "name";
  return `${noun ?? KIND_CONFIG[kind].singular}: numeric ID, or exact ${label} (case-insensitive). Strings are always treated as ${label}s, so pass IDs as numbers, not numeric strings.`;
}

function getKindCache(api: PaperlessAPI): Map<ResolvableKind, Promise<CacheEntry[]>> {
  let kinds = cache.get(api);
  if (!kinds) {
    kinds = new Map();
    cache.set(api, kinds);
  }
  return kinds;
}

async function fetchAll(
  api: PaperlessAPI,
  kind: ResolvableKind
): Promise<CacheEntry[]> {
  const { endpoint, labelField } = KIND_CONFIG[kind];
  const entries: CacheEntry[] = [];
  let path: string | null = `${endpoint}?page_size=1000`;

  for (let page = 0; path && page < MAX_PAGES; page++) {
    const response: PaginationResponse<Record<string, unknown>> =
      await api.request(path);
    for (const item of response.results ?? []) {
      const id = item.id;
      const label = item[labelField];
      if (typeof id === "number" && typeof label === "string") {
        entries.push({ id, label });
      }
    }
    path = response.next ? toRelativeApiPath(response.next) : null;
  }
  return entries;
}

/** Converts Paperless's absolute `next` URL to the path form api.request expects. */
function toRelativeApiPath(nextUrl: string): string | null {
  try {
    const url = new URL(nextUrl);
    const path = url.pathname.replace(/^\/api/, "") + url.search;
    return path.startsWith("/") ? path : `/${path}`;
  } catch {
    return null;
  }
}

function loadEntries(
  api: PaperlessAPI,
  kind: ResolvableKind,
  forceRefresh = false
): Promise<CacheEntry[]> {
  const kinds = getKindCache(api);
  if (forceRefresh || !kinds.has(kind)) {
    const promise = fetchAll(api, kind).catch((error) => {
      kinds.delete(kind);
      throw error;
    });
    kinds.set(kind, promise);
  }
  return kinds.get(kind)!;
}

function findMatches(entries: CacheEntry[], name: string): CacheEntry[] {
  const needle = name.trim().toLowerCase();
  return entries.filter((entry) => entry.label.toLowerCase() === needle);
}

function buildNotFoundError(
  kind: ResolvableKind,
  name: string,
  entries: CacheEntry[]
): Error {
  const { singular, labelField } = KIND_CONFIG[kind];
  const needle = name.trim().toLowerCase();
  const suggestions = entries
    .filter((entry) => {
      const label = entry.label.toLowerCase();
      return label.includes(needle) || needle.includes(label);
    })
    .slice(0, MAX_SUGGESTIONS);

  let hint: string;
  if (suggestions.length > 0) {
    hint = `Did you mean: ${suggestions
      .map((s) => `"${s.label}" (id ${s.id})`)
      .join(", ")}?`;
  } else if (entries.length > 0) {
    const names = entries
      .slice(0, MAX_LISTED_NAMES)
      .map((e) => `"${e.label}"`)
      .join(", ");
    const more = entries.length > MAX_LISTED_NAMES ? ", …" : "";
    hint = `Existing ${singular}s include: ${names}${more}.`;
  } else {
    hint = `No ${singular}s exist.`;
  }
  return new Error(
    `No ${singular} found matching ${labelField} "${name}". ${hint} Pass the exact ${labelField} or the numeric ID.`
  );
}

async function resolveOne(
  api: PaperlessAPI,
  kind: ResolvableKind,
  name: string
): Promise<number> {
  let entries = await loadEntries(api, kind);
  let matches = findMatches(entries, name);

  if (matches.length === 0) {
    entries = await loadEntries(api, kind, true);
    matches = findMatches(entries, name);
  }

  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length > 1) {
    const { singular, labelField } = KIND_CONFIG[kind];
    throw new Error(
      `Ambiguous ${singular} ${labelField} "${name}": matches ${matches
        .map((m) => `"${m.label}" (id ${m.id})`)
        .join(", ")}. Pass the numeric ID.`
    );
  }
  throw buildNotFoundError(kind, name, entries);
}

/** Resolves a name to its ID; numbers pass through unchanged. */
export async function resolveEntityId(
  api: PaperlessAPI,
  kind: ResolvableKind,
  ref: EntityRef
): Promise<number> {
  if (typeof ref === "number") {
    return ref;
  }
  return resolveOne(api, kind, ref);
}

/** Like resolveEntityId, but passes null/undefined through for optional params. */
export async function resolveEntityIdOrNull(
  api: PaperlessAPI,
  kind: ResolvableKind,
  ref: EntityRef | null | undefined
): Promise<number | null | undefined> {
  if (ref === null || ref === undefined) {
    return ref;
  }
  return resolveEntityId(api, kind, ref);
}

/** Resolves an array of refs, preserving order; duplicate names hit the cache. */
export async function resolveEntityIds(
  api: PaperlessAPI,
  kind: ResolvableKind,
  refs: EntityRef[]
): Promise<number[]> {
  return Promise.all(refs.map((ref) => resolveEntityId(api, kind, ref)));
}

/** Returns an id→label map for a kind, sharing the resolver's session cache. */
export async function getEntityLabelMap(
  api: PaperlessAPI,
  kind: ResolvableKind
): Promise<Map<number, string>> {
  const entries = await loadEntries(api, kind);
  return new Map(entries.map((entry) => [entry.id, entry.label]));
}

/** Resolves the users/groups arrays of a permissions block to numeric IDs. */
export async function resolveUserGroupRefs(api: PaperlessAPI, refs: {
  users?: EntityRef[];
  groups?: EntityRef[];
}): Promise<{ users?: number[]; groups?: number[] }> {
  const [users, groups] = await Promise.all([
    refs.users ? resolveEntityIds(api, "user", refs.users) : undefined,
    refs.groups ? resolveEntityIds(api, "group", refs.groups) : undefined,
  ]);
  return {
    ...(users !== undefined ? { users } : {}),
    ...(groups !== undefined ? { groups } : {}),
  };
}

/** Resolves the owner + view/change permissions shape shared by the bulk_edit_* object tools. */
export async function resolveOwnerAndPermissions(api: PaperlessAPI, args: {
  owner?: EntityRef;
  permissions?: {
    view: { users?: EntityRef[]; groups?: EntityRef[] };
    change: { users?: EntityRef[]; groups?: EntityRef[] };
  };
}): Promise<{
  owner?: number;
  permissions?: {
    view: { users?: number[]; groups?: number[] };
    change: { users?: number[]; groups?: number[] };
  };
}> {
  const [owner, view, change] = await Promise.all([
    args.owner === undefined
      ? undefined
      : resolveEntityId(api, "user", args.owner),
    args.permissions ? resolveUserGroupRefs(api, args.permissions.view) : undefined,
    args.permissions ? resolveUserGroupRefs(api, args.permissions.change) : undefined,
  ]);
  return {
    ...(owner !== undefined ? { owner } : {}),
    ...(view && change ? { permissions: { view, change } } : {}),
  };
}

interface DocumentQueryRefs {
  correspondent?: EntityRef;
  document_type?: EntityRef;
  tag?: EntityRef;
  storage_path?: EntityRef;
  owner?: EntityRef;
}

/** Resolves the entity-reference filters shared by the document query tools. */
export async function resolveDocumentQueryRefs<T extends DocumentQueryRefs>(
  api: PaperlessAPI,
  args: T
): Promise<T> {
  const [correspondent, document_type, tag, storage_path, owner] =
    await Promise.all([
      resolveEntityIdOrNull(api, "correspondent", args.correspondent),
      resolveEntityIdOrNull(api, "document_type", args.document_type),
      resolveEntityIdOrNull(api, "tag", args.tag),
      resolveEntityIdOrNull(api, "storage_path", args.storage_path),
      resolveEntityIdOrNull(api, "user", args.owner),
    ]);
  return {
    ...args,
    ...(correspondent !== undefined ? { correspondent } : {}),
    ...(document_type !== undefined ? { document_type } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(storage_path !== undefined ? { storage_path } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

export function clearResolverCache(api?: PaperlessAPI): void {
  if (api) {
    cache.delete(api);
  }
}
