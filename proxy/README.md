# paperless-upload-proxy

A single-purpose HTTP service that lets clients upload large files to
[Paperless-NGX](https://docs.paperless-ngx.com/) without pushing file content
through the MCP protocol. The companion MCP tool `request_upload_url` mints a
short-lived, single-use upload URL here; the client then POSTs the file
directly to that URL and the proxy streams it to Paperless with the minting
user's token, so document ownership lands on the right user.

See `../paperless-signed-upload-spec.md` for the full design.

## How it works

1. **Mint.** `POST /mint` with `Authorization: Token <paperless token>` and an
   optional JSON body (`title`, `correspondent`, `document_type`, `tags`,
   `created`, `max_bytes`, `ttl_seconds`). The proxy validates the token
   against Paperless, stores it encrypted under an ephemeral per-process key,
   and returns a capability URL:

   ```json
   {
     "upload_url": "https://uploads.example.com/upload/Kf3q8v...",
     "expires_at": "2026-07-12T15:30:00Z",
     "max_bytes": 104857600,
     "curl_example": "curl -sf -X POST -F 'document=@FILE.pdf' '<upload_url>'"
   }
   ```

2. **Upload.** `POST /upload/{id}` as multipart form data with a single
   `document` field. The record is deleted on lookup (single use), the file is
   forwarded to Paperless, and the response carries Paperless's consumption
   task UUID: `{"status":"ok","task_id":"<uuid>"}`.

   Paperless's WSGI server requires a `Content-Length` and rejects chunked
   bodies, so the proxy spools each upload to a temp file (never holding it
   whole in memory) and re-sends it with an exact length, the same way a
   buffering reverse proxy does. The temp file is deleted as soon as the
   forward completes, on success and failure alike.

`GET /healthz` returns `200 ok`. There are no other routes.

The proxy holds no configuration secrets: its only authority comes from tokens
presented at mint time, encrypted at rest under a key generated fresh at every
startup. A restart invalidates all pending URLs and makes any leaked state
undecryptable.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PAPERLESS_URL` | yes | — | Paperless base URL reachable from the proxy, e.g. `http://paperless:8000` |
| `ALLOWED_HOST` | yes | — | Public hostname the proxy serves, e.g. `uploads.example.com`. Every request's `Host` header must match exactly (421 otherwise); also used to build returned upload URLs. |
| `LISTEN_ADDR` | no | `0.0.0.0:8080` | Bind address |
| `MAX_BYTES_CEILING` | no | `104857600` | Absolute upload cap; mint requests are clamped to it |
| `PENDING_LIMIT` | no | `100` | Max concurrent pending mints (memory bound) |
| `PUBLIC_SCHEME` | no | `https` | Scheme of returned upload URLs. Only set to `http` in test stacks without a TLS reverse proxy. |

## Deployment

Run next to Paperless on its Docker network, behind a TLS-terminating reverse
proxy:

```yaml
  paperless-upload-proxy:
    build: ./proxy
    restart: unless-stopped
    environment:
      PAPERLESS_URL: http://paperless:8000
      ALLOWED_HOST: uploads.example.com
    networks:
      - paperless
    # Expose only to the reverse proxy, not the world:
    # ports: ["127.0.0.1:8091:8080"]
```

Reverse proxy requirements (nginx shown):

- Terminate TLS for the chosen hostname; the proxy itself speaks only HTTP.
- Forward the original Host header: `proxy_set_header Host $host;`
- Raise the body limit to at least `MAX_BYTES_CEILING`: `client_max_body_size 100m;`
- Optionally stream uploads instead of spooling: `proxy_request_buffering off;`

## Development

```bash
cargo test          # unit + integration tests (mocked Paperless)
cargo build --release
docker build -t paperless-upload-proxy .
```
