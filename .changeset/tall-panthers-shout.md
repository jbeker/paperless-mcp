---
"@baruchiro/paperless-mcp": minor
---

Add MCP tool annotations to all tools. Every tool now declares readOnlyHint, destructiveHint, idempotentHint, and openWorldHint so clients can gate destructive operations: list/get/who_am_i tools are read-only; create/update tools are read-write and non-destructive; delete tools, delete-capable bulk_edit tools, and process_mail_account (mail rules can delete mails from the mailbox) are destructive.
