---
"@baruchiro/paperless-mcp": major
---

Replace in-band document upload with proxy-minted upload URLs.

- New `request_upload_url` tool mints a short-lived, single-use upload URL from a
  companion upload proxy (new `proxy/` Rust service), authenticating with the
  session's Paperless token so document ownership lands on the minting user.
  Files are then POSTed directly to the proxy and streamed to Paperless, so
  uploads no longer fail for files beyond a few megabytes.
- BREAKING: the `post_document` tool (base64 and `file_path` modes) is removed;
  large uploads silently failed through that path. The
  `PAPERLESS_MCP_UPLOAD_PATHS` environment variable no longer has any effect.
- New `UPLOAD_PROXY_URL` environment variable configures the proxy base URL;
  without it, `request_upload_url` returns a clear configuration error.
