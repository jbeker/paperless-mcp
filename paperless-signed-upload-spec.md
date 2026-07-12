# Paperless Upload Proxy Spec

**Version:** 0.6
**Date:** 2026-07-12
**Status:** Draft
**Changes in 0.6:** The fork disables the existing base64 upload tool so that large uploads cannot silently fall back to the broken path.
**Changes in 0.5:** Constraints settled. The MCP fork makes no extraneous changes: the diff is one tool and one env var, nothing else. The proxy is written in Rust, deployed via Docker, sits behind a reverse proxy that terminates TLS, and validates the Host header against a configured value.
**Changes in 0.4:** Ephemeral process key: a fresh random key generated at every startup encrypts all retained data, so nothing survives a restart. Any future signing keys follow the same rule.
**Changes in 0.3:** Removed all dependencies outside the paperless MCP itself. The mint step authenticates with the Paperless token the MCP already holds. No signing, no shared secrets, no per-user configuration.

## Problem

The Paperless MCP (`@baruchiro/paperless-mcp`) uploads documents by passing base64 file content through the MCP protocol. This fails for PDFs beyond a few megabytes. The MCP server holds the user's Paperless API token and can call the REST API, but it cannot reach the file, which lives on the client side. The client can reach the file but must not hold the token.

Multiple users share one Paperless instance. Paperless-NGX assigns document ownership to the authenticated uploader, and `post_document` accepts no owner field, so each upload must be made with the owning user's own token.

## Solution Overview

Split upload into two steps, bridged by a small proxy:

1. **Mint.** A new MCP tool calls the proxy's `/mint` endpoint, authenticating with the same Paperless token the MCP already uses for every other tool. The proxy verifies the token against Paperless, stores it (encrypted under the ephemeral process key) together with the requested metadata and limits, keyed by a random upload ID, and returns a short-lived, single-use upload URL.
2. **Upload.** The client POSTs the file (`curl -F`) to that URL. The proxy looks up the upload ID, decrypts the stored token, streams the body to Paperless's `/api/documents/post_document/`, and deletes the record.

The URL is an opaque capability: a 256-bit random ID with no embedded credentials. Nothing is signed; authenticity comes from unguessability, single use from atomic delete-on-lookup, and all constraints from the server-side record. Ownership is correct by construction because the forward request authenticates as the user who minted. A valid Paperless token is the entire identity system; no per-user configuration exists anywhere.

```
Claude ──(MCP tool call)──> paperless-mcp
   │                            │ POST /mint  (Authorization: Token <user's token>)
   │                            ▼
   │      reverse proxy ──> upload proxy ──(validates token)──> Paperless
   │      (TLS)                 │ stores {enc(token), meta, exp, max} by upload_id
   │ <──── upload_url ──────────┘
   │
   └──(curl -F)──> reverse proxy ──> upload proxy ──(streams + token)──> Paperless
                   (TLS)             (Host check)                  owner = minting user
```

## Components

| Component | Change | Dependencies |
|---|---|---|
| Paperless MCP | Fork; one tool added, one disabled, one env var | Existing token; HTTPS reach to the proxy |
| Upload proxy | New Rust service, one binary, Docker | Network path to Paperless; reverse proxy for TLS |
| Paperless | None | Users already have tokens |

The MCP instance can run anywhere (a laptop, a server, an aggregator); it needs only HTTPS access to the proxy's public base URL.

## MCP Changes

Fork `baruchiro/paperless-mcp` and add one tool.

**Minimal diff policy.** The fork makes no extraneous changes. No refactoring, no dependency updates, and no formatting churn. The entire diff is three things: the new tool, its env var, and disabling the existing base64 upload tool. Disabling means removing the tool's registration so it is not exposed, not deleting its implementation, which keeps the change to a few lines and the fork trivially rebasable on upstream. Removing it prevents a client from falling back to the broken path when the proxy is what should be used.

### New tool: `request_upload_url`

**Input:**

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `title` | string | no | Passed to Paperless at upload |
| `correspondent` | integer | no | Paperless correspondent ID |
| `document_type` | integer | no | Paperless document type ID |
| `tags` | integer[] | no | Paperless tag IDs |
| `created` | string | no | `YYYY-MM-DD` |
| `max_bytes` | integer | no | Default 104857600 (100 MB); proxy enforces its own ceiling |
| `ttl_seconds` | integer | no | Default 900; proxy caps at 3600 |

**Behavior:** POST to `{UPLOAD_PROXY_URL}/mint` with header `Authorization: Token {PAPERLESS_API_KEY}` (the token the MCP already holds) and a JSON body of the parameters above. Return the proxy's response unchanged.

**Output:**

```json
{
  "upload_url": "https://uploads.example.com/upload/Kf3q8v...",
  "expires_at": "2026-07-12T15:30:00Z",
  "max_bytes": 104857600,
  "curl_example": "curl -sf -X POST -F 'document=@FILE.pdf' '<upload_url>'"
}
```

### New environment variable

| Variable | Purpose |
|---|---|
| `UPLOAD_PROXY_URL` | Base URL of the proxy, e.g. `https://uploads.example.com` |

If unset, the tool returns an error explaining that the upload proxy is not configured. All other configuration (`PAPERLESS_URL` or equivalent, `PAPERLESS_API_KEY`) already exists in the MCP.

## Upload Proxy

A single-purpose HTTP service holding no user configuration and no long-lived credentials of its own.

**Implementation:** Rust with axum, tokio, and reqwest (streaming), with `zeroize` for plaintext handling and `chacha20poly1305` for record encryption. Compiled as a static binary (musl target) into a distroless or scratch image, around 10 MB. Deployed via Docker. TLS is not the proxy's concern; a reverse proxy in front terminates TLS and forwards plain HTTP.

### Host header validation

The proxy validates the `Host` header of every request against the `ALLOWED_HOST` env variable before any routing. Comparison is case-insensitive and exact, including the port if the configured value carries one. A mismatch returns `421 Misdirected Request` with no other processing. This rejects traffic that reaches the container directly, arrives through a misconfigured vhost, or comes from DNS rebinding, and it guarantees the proxy serves only the hostname it was deployed for. The reverse proxy must therefore forward the original Host header (`proxy_set_header Host $host;` for nginx).

### Ephemeral process key

At startup, before binding the listener, the proxy generates a 256-bit key from the OS CSPRNG. This key:

- Exists only in process memory. It is never written to disk, env, logs, or any persistence layer, and there is no configuration option to supply one.
- Encrypts every retained record. Pending mint records store the Paperless token as AEAD ciphertext (XChaCha20-Poly1305, unique nonce per record, `upload_id` as associated data so a ciphertext cannot be moved between records).
- Dies with the process. A restart generates a new key, so any state that leaked to swap, a core dump, or an accidental future persistence path is undecryptable afterward. Restart invalidates everything by cryptography, not just by convention.

Plaintext tokens exist only in two moments: during mint validation, and during the upload forward. Both are followed by zeroization of the plaintext buffer. Best-effort process hardening accompanies this: disable core dumps (`RLIMIT_CORE = 0`) and attempt `mlock` on the key page, degrading gracefully where the container denies it.

### Endpoints

All endpoints are subject to the Host header check first.

**`POST /mint`**

Headers: `Authorization: Token <paperless token>`. Body: JSON with the optional metadata and limit fields listed above.

1. Reject if the Authorization header is missing, else `401`.
2. Validate the token with one cheap authenticated request to Paperless (`GET /api/profile/`, falling back to `GET /api/documents/?page_size=1` on older versions). A non-200 yields `401`; a Paperless outage yields `502`.
3. Clamp `max_bytes` to `MAX_BYTES_CEILING` and `ttl_seconds` to 3600.
4. Generate `upload_id` (256-bit random, base64url), encrypt the token under the process key with `upload_id` as associated data, zeroize the plaintext, and store `{enc_token, meta, max, exp}`.
5. Return the upload URL (built from `https://{ALLOWED_HOST}`), expiry, and effective limits.

**`POST /upload/{upload_id}`**

Multipart form, single field `document`. Validation order, failing fast:

1. `upload_id` exists and is unexpired, else `403`. Delete the record immediately on lookup, before forwarding, so a slow upload cannot race a second use.
2. `Content-Length` present and at or below `max`, else `413`. Count streamed bytes as a backstop and abort at `max + 1`.
3. Decrypt the stored token, stream the file to `{PAPERLESS_URL}/api/documents/post_document/` with `Authorization: Token <token>`, attaching the stored metadata as form fields, then zeroize the plaintext. Never buffer the whole file in memory.

**Responses:**

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"status":"ok","task_id":"<uuid>"}` | Accepted; `task_id` is Paperless's consumption task UUID |
| 400 | `{"error":"..."}` | Malformed request |
| 401 | `{"error":"..."}` | Mint with missing or invalid token |
| 403 | `{"error":"unknown or expired upload"}` | Bad, used, or expired upload ID |
| 413 | `{"error":"file too large"}` | Over `max` |
| 421 | `{"error":"misdirected request"}` | Host header mismatch |
| 502 | `{"error":"..."}` | Paperless unreachable or rejected the request |

**`GET /healthz`** returns `200 ok`. No other routes exist.

### State

An in-memory map of `upload_id → {enc_token, meta, max, exp}`, swept every minute. Single replica; no persistence. A restart drops pending mints and rotates the process key, which fails closed twice over: outstanding URLs stop resolving, and any residue of the old state is undecryptable. The client simply mints again.

### Configuration

| Variable | Purpose |
|---|---|
| `PAPERLESS_URL` | Paperless base URL reachable from the proxy, e.g. `http://paperless:8000` on a shared Docker network |
| `ALLOWED_HOST` | Public hostname the proxy serves, e.g. `uploads.example.com`. Required; the proxy refuses to start without it. Also used to build returned upload URLs. |
| `LISTEN_ADDR` | Default `0.0.0.0:8080` |
| `MAX_BYTES_CEILING` | Absolute upload cap. Default 104857600. |
| `PENDING_LIMIT` | Max concurrent pending mints, a memory bound. Default 100. |

No secrets and no key material. The proxy's authority derives from tokens presented at mint time, and its only key is generated per process.

## Deployment

The proxy runs next to Paperless, in the same compose stack, joining its Docker network so `PAPERLESS_URL` stays internal. A reverse proxy in front terminates TLS and forwards plain HTTP with the original Host header.

```yaml
  paperless-upload-proxy:
    image: paperless-upload-proxy:latest
    restart: unless-stopped
    environment:
      PAPERLESS_URL: http://paperless:8000
      ALLOWED_HOST: uploads.example.com
    networks:
      - paperless
    # Expose only to the reverse proxy, not the world:
    # ports: ["127.0.0.1:8091:8080"]
```

Reverse proxy requirements:

- TLS termination for the chosen hostname; the proxy itself speaks only HTTP.
- Forward the original Host header (`proxy_set_header Host $host;` for nginx).
- Raise the request body limit to at least `MAX_BYTES_CEILING` (`client_max_body_size 100m;` for nginx).
- Optionally disable request buffering for the upload path (`proxy_request_buffering off;`) so large files stream rather than spool to disk at the reverse proxy.

**Image.** Multi-stage Dockerfile: a Rust build stage (musl) compiles the static binary; the final stage is `gcr.io/distroless/static` or `scratch`. The image has no baked-in configuration and no key material.

## Security Considerations

- **Host header validation.** Every request is checked against `ALLOWED_HOST` before routing, rejecting direct-to-container traffic, vhost misrouting, and DNS rebinding with `421`.
- **Ephemeral key invariant.** All retained sensitive data is ciphertext under a per-process key that cannot outlive the process. There is deliberately no way to configure a persistent key, so no future change can quietly make state durable without revisiting this section.
- **Tokens in transit and at rest.** The user token transits MCP-to-proxy once per mint over TLS, the same exposure class as the MCP's existing calls to Paperless. At rest in memory it is AEAD ciphertext; plaintext exists only at mint validation and upload forwarding, followed by zeroization.
- **Capability URL strength.** 256 bits of randomness from a CSPRNG; lookup by exact match, deleted on first use. Nothing is signed by design; authenticity is unguessability, and if a signed artifact is ever introduced, its key follows the ephemeral rule.
- **Mint requires proof of identity.** `/mint` performs a live token check against Paperless, so the endpoint grants nothing to anonymous callers beyond a cheap 401. `PENDING_LIMIT` bounds memory against mint flooding; a per-IP rate limit at the reverse proxy is a free addition.
- **No secrets in logs.** Log upload IDs, sizes, Paperless usernames if desired (from the mint validation response), and outcomes. Never log tokens or Authorization headers.
- **Fail closed on size.** Both the `Content-Length` check and streamed byte counting are required, since chunked encoding can omit the header.
- **Full-privilege tokens.** Paperless has no scoped tokens, so the decrypted token at forward time is the user's full token. The proxy's attack surface is kept minimal in compensation: two routes, no persistence, one outbound call pattern, core dumps disabled.
- **Version note.** Verify against the installed Paperless-NGX version that `post_document` accepts no owner field, that ownership follows the token's user, and which profile endpoint suits token validation.

## Usage Flow

1. `request_upload_url` with title and tag IDs. The MCP mints against the proxy and returns the URL with a curl example.
2. `curl -sf -X POST -F 'document=@scan.pdf' '<upload_url>'` from wherever the file lives, including a Claude sandbox.
3. Proxy returns the task UUID. The document appears in the minting user's archive with correct ownership; consumption status is visible through the existing MCP tools once ingestion completes.

## Open Questions

1. **Hostname.** The value of `ALLOWED_HOST`: dedicated subdomain versus a path on an existing host. A dedicated subdomain keeps the Host check simple; path-based routing would require a base-path config addition.
2. **Task status passthrough.** Whether to add a task-polling route (which would require holding the token past upload) or rely on the existing MCP tools after consumption. Deferring keeps token lifetime minimal and v1 to two routes.
3. **Fork maintenance.** Carry the fork long-term, or propose the tool upstream to `baruchiro/paperless-mcp` with the proxy published as a companion project. The minimal diff policy keeps both options open.
4. **Token validation endpoint.** Confirm `/api/profile/` availability on the installed version, or select the fallback.

## Milestones

1. Proxy binary in Rust: Host check, process key generation, AEAD-encrypted records with zeroization, mint, upload, sweep, `PENDING_LIMIT`; unit tests for Host mismatch, expiry, single use, size enforcement, invalid-token mint, and an assertion that stored records contain no plaintext token bytes.
2. Dockerfile (musl build, distroless final stage), compose entry next to Paperless, reverse proxy route with Host forwarding and raised body limit.
3. MCP fork with `request_upload_url` and `UPLOAD_PROXY_URL`, and the base64 upload tool unregistered, under the minimal diff policy.
4. End-to-end test per user with a 50 MB PDF, ownership verification in Paperless, reuse test, expiry test, oversize test, wrong-Host test, and a restart test confirming pending URLs die and the key rotates.
