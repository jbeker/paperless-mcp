---
"@baruchiro/paperless-mcp": patch
---

Support installing directly from a git URL (`npx -y github:<owner>/paperless-mcp`): add a `prepare` script so npm compiles `build/` on git installs, and exclude `build/` in tsconfig so repeated builds no longer fail with TS5055.
