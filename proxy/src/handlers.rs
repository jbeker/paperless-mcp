use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use axum::{
    extract::{Multipart, Path, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use crate::config::{Config, DEFAULT_MAX_BYTES, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS};
use crate::crypto::{generate_upload_id, ProcessKey};
use crate::state::{PendingStore, PendingUpload, UploadMeta};

pub struct AppState {
    pub config: Config,
    pub key: ProcessKey,
    pub store: PendingStore,
    pub http: reqwest::Client,
}

pub fn build_app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/mint", post(mint))
        .route("/upload/{upload_id}", post(upload))
        .route("/healthz", get(|| async { "ok" }))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            check_host,
        ))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(state)
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// Rejects any request whose Host header does not exactly match ALLOWED_HOST
/// (case-insensitive, port included), before any routing.
async fn check_host(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let host_matches = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|host| host.trim().eq_ignore_ascii_case(&state.config.allowed_host))
        .unwrap_or(false);
    if !host_matches {
        return error_response(StatusCode::MISDIRECTED_REQUEST, "misdirected request");
    }
    next.run(request).await
}

#[derive(Debug, Default, Deserialize)]
pub struct MintRequest {
    pub title: Option<String>,
    pub correspondent: Option<u64>,
    pub document_type: Option<u64>,
    pub tags: Option<Vec<u64>>,
    pub created: Option<String>,
    pub max_bytes: Option<u64>,
    pub ttl_seconds: Option<u64>,
}

#[derive(Serialize)]
struct MintResponse {
    upload_url: String,
    expires_at: String,
    max_bytes: u64,
    curl_example: String,
}

async fn mint(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<MintRequest>>,
) -> Response {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "missing Authorization: Token header",
            )
        }
    };

    match validate_token(&state, &token).await {
        TokenCheck::Valid => {}
        TokenCheck::Invalid => {
            return error_response(StatusCode::UNAUTHORIZED, "invalid Paperless token")
        }
        TokenCheck::Unreachable => {
            return error_response(StatusCode::BAD_GATEWAY, "Paperless unreachable")
        }
    }

    let req = body.map(|Json(b)| b).unwrap_or_default();
    let max_bytes = req
        .max_bytes
        .unwrap_or(DEFAULT_MAX_BYTES)
        .min(state.config.max_bytes_ceiling);
    let ttl_seconds = req
        .ttl_seconds
        .unwrap_or(DEFAULT_TTL_SECONDS)
        .min(MAX_TTL_SECONDS);

    let upload_id = generate_upload_id();
    let enc_token = state.key.seal(token.as_bytes(), upload_id.as_bytes());
    drop(token);

    let record = PendingUpload {
        enc_token,
        meta: UploadMeta {
            title: req.title,
            correspondent: req.correspondent,
            document_type: req.document_type,
            tags: req.tags,
            created: req.created,
        },
        max_bytes,
        expires_at: Instant::now() + Duration::from_secs(ttl_seconds),
    };

    if state
        .store
        .insert(upload_id.clone(), record, state.config.pending_limit)
        .is_err()
    {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "too many pending uploads, try again later",
        );
    }

    let upload_url = format!(
        "{}://{}/upload/{}",
        state.config.public_scheme, state.config.allowed_host, upload_id
    );
    let expires_at = rfc3339(SystemTime::now() + Duration::from_secs(ttl_seconds));
    let curl_example = format!(
        "curl -sf -X POST -F 'document=@FILE.pdf' '{upload_url}'"
    );

    tracing::info!(upload_id, max_bytes, ttl_seconds, "minted upload URL");

    (
        StatusCode::OK,
        Json(MintResponse {
            upload_url,
            expires_at,
            max_bytes,
            curl_example,
        }),
    )
        .into_response()
}

async fn upload(
    State(state): State<Arc<AppState>>,
    Path(upload_id): Path<String>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    // Remove-on-lookup: the record is gone before any forwarding starts, so a
    // second request with the same ID fails even while the first is in flight.
    let record = match state.store.take(&upload_id) {
        Some(r) => r,
        None => return error_response(StatusCode::FORBIDDEN, "unknown or expired upload"),
    };

    let content_length = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    match content_length {
        Some(len) if len <= record.max_bytes => {}
        _ => return error_response(StatusCode::PAYLOAD_TOO_LARGE, "file too large"),
    }

    let field = loop {
        match multipart.next_field().await {
            Ok(Some(f)) if f.name() == Some("document") => break f,
            Ok(Some(_)) => continue,
            Ok(None) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "multipart field 'document' is required",
                )
            }
            Err(_) => return error_response(StatusCode::BAD_REQUEST, "malformed multipart body"),
        }
    };
    let filename = field
        .file_name()
        .filter(|n| !n.is_empty())
        .unwrap_or("document")
        .to_string();

    let token = match state.key.open(&record.enc_token, upload_id.as_bytes()) {
        Some(t) => t,
        None => {
            // Only possible if state were tampered with; treat as unknown.
            return error_response(StatusCode::FORBIDDEN, "unknown or expired upload")
        }
    };
    let auth_header = Zeroizing::new(format!(
        "Token {}",
        String::from_utf8_lossy(&token)
    ));
    drop(token);

    // Paperless sits behind a WSGI server that requires Content-Length, so the
    // file cannot be re-streamed chunked. Spool it to a temp file (bounded by
    // max_bytes, never held whole in memory), then forward with exact length.
    // Byte counting doubles as the fail-closed backstop for requests whose
    // Content-Length lied.
    let mut spool = match SpoolFile::create(&upload_id).await {
        Ok(s) => s,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not spool upload",
            )
        }
    };
    let mut field = field;
    let mut streamed: u64 = 0;
    loop {
        match field.chunk().await {
            Ok(Some(chunk)) => {
                streamed += chunk.len() as u64;
                if streamed > record.max_bytes {
                    return error_response(StatusCode::PAYLOAD_TOO_LARGE, "file too large");
                }
                if spool.write_all(&chunk).await.is_err() {
                    return error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "could not spool upload",
                    );
                }
            }
            Ok(None) => break,
            Err(_) => return error_response(StatusCode::BAD_REQUEST, "malformed multipart body"),
        }
    }

    let outgoing_body = match spool.streaming_body().await {
        Ok(b) => b,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not spool upload",
            )
        }
    };

    let mut form = reqwest::multipart::Form::new().part(
        "document",
        reqwest::multipart::Part::stream_with_length(outgoing_body, streamed)
            .file_name(filename),
    );
    if let Some(title) = &record.meta.title {
        form = form.text("title", title.clone());
    }
    if let Some(correspondent) = record.meta.correspondent {
        form = form.text("correspondent", correspondent.to_string());
    }
    if let Some(document_type) = record.meta.document_type {
        form = form.text("document_type", document_type.to_string());
    }
    if let Some(tags) = &record.meta.tags {
        for tag in tags {
            form = form.text("tags", tag.to_string());
        }
    }
    if let Some(created) = &record.meta.created {
        form = form.text("created", created.clone());
    }

    let forward_result = state
        .http
        .post(format!(
            "{}/api/documents/post_document/",
            state.config.paperless_url
        ))
        .header(header::AUTHORIZATION, auth_header.as_str())
        .multipart(form)
        .send()
        .await;
    drop(auth_header);
    drop(spool);

    let response = match forward_result {
        Ok(r) => r,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Paperless unreachable"),
    };
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail: String = text.chars().take(500).collect();
        tracing::warn!(upload_id, %status, detail, "Paperless rejected upload");
        return error_response(StatusCode::BAD_GATEWAY, "Paperless rejected the upload");
    }

    // Paperless returns the consumption task UUID as a JSON-encoded string.
    let task_id = serde_json::from_str::<String>(&text).unwrap_or(text);
    tracing::info!(upload_id, streamed, task_id, "upload forwarded");
    (
        StatusCode::OK,
        Json(json!({ "status": "ok", "task_id": task_id })),
    )
        .into_response()
}

/// Temp file holding one upload while it is re-sent to Paperless with a known
/// Content-Length (Paperless's WSGI server rejects chunked bodies). Removed on
/// drop, so every early-return path cleans up.
struct SpoolFile {
    path: std::path::PathBuf,
    file: Option<tokio::fs::File>,
}

impl SpoolFile {
    async fn create(upload_id: &str) -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(format!("plup-{upload_id}"));
        let file = tokio::fs::File::create(&path).await?;
        Ok(SpoolFile {
            path,
            file: Some(file),
        })
    }

    async fn write_all(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        self.file
            .as_mut()
            .expect("write after streaming_body")
            .write_all(chunk)
            .await
    }

    async fn streaming_body(&mut self) -> std::io::Result<reqwest::Body> {
        use tokio::io::AsyncWriteExt;
        let mut file = self.file.take().expect("streaming_body called twice");
        file.flush().await?;
        drop(file);
        let reader = tokio::fs::File::open(&self.path).await?;
        Ok(reqwest::Body::wrap_stream(
            tokio_util::io::ReaderStream::new(reader),
        ))
    }
}

impl Drop for SpoolFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn extract_token(headers: &HeaderMap) -> Option<Zeroizing<String>> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Token ")?.trim();
    if token.is_empty() {
        return None;
    }
    Some(Zeroizing::new(token.to_string()))
}

enum TokenCheck {
    Valid,
    Invalid,
    Unreachable,
}

/// Proves the caller holds a working Paperless token with one cheap
/// authenticated request. `/api/profile/` is preferred; older versions
/// without it (404) fall back to a one-item document list.
async fn validate_token(state: &AppState, token: &str) -> TokenCheck {
    let auth = Zeroizing::new(format!("Token {token}"));
    let profile = state
        .http
        .get(format!("{}/api/profile/", state.config.paperless_url))
        .header(header::AUTHORIZATION, auth.as_str())
        .send()
        .await;
    let status = match profile {
        Ok(r) => r.status(),
        Err(_) => return TokenCheck::Unreachable,
    };
    if status.is_success() {
        return TokenCheck::Valid;
    }
    if status != reqwest::StatusCode::NOT_FOUND {
        return TokenCheck::Invalid;
    }
    let fallback = state
        .http
        .get(format!(
            "{}/api/documents/?page_size=1",
            state.config.paperless_url
        ))
        .header(header::AUTHORIZATION, auth.as_str())
        .send()
        .await;
    match fallback {
        Ok(r) if r.status().is_success() => TokenCheck::Valid,
        Ok(_) => TokenCheck::Invalid,
        Err(_) => TokenCheck::Unreachable,
    }
}

/// Formats a SystemTime as RFC 3339 UTC with second precision, without
/// pulling in a date-time crate.
fn rfc3339(t: SystemTime) -> String {
    let secs = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60
    )
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_formats_known_timestamp() {
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(1_752_334_200);
        assert_eq!(rfc3339(t), "2025-07-12T15:30:00Z");
    }
}
