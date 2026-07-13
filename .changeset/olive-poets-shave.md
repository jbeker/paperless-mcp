---
"@baruchiro/paperless-mcp": patch
---

Refresh stale name-lookup caches and stop fabricating names for unresolvable IDs.

- The label cache used for output enrichment was populated once per entity type and never refreshed, so entities created (or made visible) after the first lookup rendered as stringified IDs for the rest of the process lifetime. Enrichment now refetches an entity type's table once whenever a requested ID is missing from the cache — matching the input resolver's existing refetch-on-miss behavior.
- When an ID still cannot be resolved after refresh (deleted, or not visible to the token), enriched fields now report `name: null` instead of the misleading stringified ID (`{"id": 37, "name": "37"}`), so unresolvable references are visible instead of looking like real names.
- Enrichment now only fetches lookup tables for entity types actually referenced by the documents being returned.
