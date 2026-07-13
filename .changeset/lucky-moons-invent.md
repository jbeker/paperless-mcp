---
"@baruchiro/paperless-mcp": minor
---

Expose more of the Paperless API: 18 new tools.

- `get_document_suggestions` — Paperless's ML classification hints, enriched to `{id, name}` pairs
- `get_document_metadata`, `get_next_asn`, `delete_document` (soft-delete to trash, confirm-gated), `get_tag`
- Tasks: `list_tasks` (filter by status/Celery task_id/name/type — check upload consumption), `get_task`, `acknowledge_tasks`
- System: `get_statistics`, `get_system_status`
- Trash: `list_trash`, `restore_from_trash`, `empty_trash` (confirm-gated; omitting documents wipes the entire trash)
- Workflows: full CRUD (`list/get/create/update/delete_workflow`) with triggers and actions defined inline; entity references in triggers/actions accept numeric IDs or exact names, including mail rules
