---
"@baruchiro/paperless-mcp": minor
---

Fix and complete name enrichment on document responses, and add an owner filter.

- Fix: document responses rendered entity names as stringified IDs (e.g. `{"id": 3, "name": "3"}`) whenever the entity fell beyond the first page of its lookup table. The response enhancer now uses the resolver's cached, pagination-following label maps.
- Document responses now enrich `owner` (as `{id, name}` with the username; degrades to the bare ID when the token cannot list users) and `storage_path` (previously left as a raw ID).
- `list_documents` and `query_documents` gain a first-class `owner` filter accepting a username or numeric ID — previously owner filtering required `paperless_filters: {"owner__id": N}`.
