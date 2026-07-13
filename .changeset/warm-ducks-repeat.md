---
"@baruchiro/paperless-mcp": minor
---

Accept names anywhere tools previously required numeric system IDs, and add identity tools.

- Entity-reference parameters (correspondent, document type, tags, storage path, custom fields, mail account, owner, and permission users/groups) now accept either a numeric ID or an exact, case-insensitive name. Names are resolved inside the server; unknown or ambiguous names return an error listing close candidates. Existing numeric calls behave unchanged.
- New `who_am_i` tool returns the identity of the user whose API token the connection uses (id, username, name, email, group names, staff/superuser/active flags).
- New `list_users`, `list_groups`, and `list_storage_paths` tools for discovering valid owners, permission targets, and storage paths — none of these had a lookup path before.
