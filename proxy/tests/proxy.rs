use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use http_body_util::BodyExt;
use tower::ServiceExt;

use paperless_upload_proxy::config::Config;
use paperless_upload_proxy::crypto::ProcessKey;
use paperless_upload_proxy::handlers::{build_app, AppState};
use paperless_upload_proxy::state::PendingStore;

const GOOD_TOKEN: &str = "good-token-abcdef";
const ALLOWED_HOST: &str = "uploads.test";
const TASK_ID: &str = "11111111-2222-3333-4444-555555555555";
const BOUNDARY: &str = "----proxytestboundary";

#[derive(Default, Clone)]
struct ReceivedUpload {
    authorization: String,
    filename: String,
    document: Vec<u8>,
    fields: Vec<(String, String)>,
}

type Captured = Arc<Mutex<Option<ReceivedUpload>>>;

/// Minimal fake Paperless: token check on /api/profile/ (optionally 404 to
/// exercise the fallback), and a post_document that captures what it got.
async fn start_mock_paperless(profile_missing: bool) -> (String, Captured) {
    let captured: Captured = Arc::new(Mutex::new(None));
    let captured_clone = captured.clone();

    let check_auth = |headers: &axum::http::HeaderMap| {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            == Some(&format!("Token {GOOD_TOKEN}"))
    };

    let profile = move |headers: axum::http::HeaderMap| async move {
        if profile_missing {
            return StatusCode::NOT_FOUND;
        }
        if check_auth(&headers) {
            StatusCode::OK
        } else {
            StatusCode::UNAUTHORIZED
        }
    };
    let documents = move |headers: axum::http::HeaderMap| async move {
        if check_auth(&headers) {
            StatusCode::OK
        } else {
            StatusCode::UNAUTHORIZED
        }
    };
    let post_document = move |headers: axum::http::HeaderMap,
                              mut multipart: axum::extract::Multipart| {
        let captured = captured_clone.clone();
        async move {
            let mut received = ReceivedUpload {
                authorization: headers
                    .get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string(),
                ..Default::default()
            };
            while let Ok(Some(field)) = multipart.next_field().await {
                let name = field.name().unwrap_or_default().to_string();
                if name == "document" {
                    received.filename = field.file_name().unwrap_or_default().to_string();
                    received.document = field.bytes().await.unwrap().to_vec();
                } else {
                    received
                        .fields
                        .push((name, field.text().await.unwrap_or_default()));
                }
            }
            *captured.lock().unwrap() = Some(received);
            (StatusCode::OK, format!("\"{TASK_ID}\""))
        }
    };

    let app = Router::new()
        .route("/api/profile/", get(profile))
        .route("/api/documents/", get(documents))
        .route("/api/documents/post_document/", post(post_document));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), captured)
}

fn test_config(paperless_url: &str) -> Config {
    Config {
        paperless_url: paperless_url.to_string(),
        allowed_host: ALLOWED_HOST.to_string(),
        listen_addr: "127.0.0.1:0".to_string(),
        max_bytes_ceiling: 1024 * 1024,
        pending_limit: 3,
        public_scheme: "https".to_string(),
    }
}

fn build_state(paperless_url: &str) -> Arc<AppState> {
    Arc::new(AppState {
        config: test_config(paperless_url),
        key: ProcessKey::generate(),
        store: PendingStore::new(),
        http: reqwest::Client::new(),
    })
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn mint_request(body: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/mint")
        .header(header::HOST, ALLOWED_HOST)
        .header(header::AUTHORIZATION, format!("Token {GOOD_TOKEN}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn mint(app: &Router, body: &str) -> serde_json::Value {
    let response = app.clone().oneshot(mint_request(body)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

fn multipart_body(filename: &str, content: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{filename}\"\r\nContent-Type: application/pdf\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    body
}

fn upload_path(mint_response: &serde_json::Value) -> String {
    let url = mint_response["upload_url"].as_str().unwrap();
    let prefix = format!("https://{ALLOWED_HOST}");
    assert!(url.starts_with(&prefix), "unexpected upload_url: {url}");
    url[prefix.len()..].to_string()
}

fn upload_request(path: &str, body: Vec<u8>, content_length: Option<u64>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::HOST, ALLOWED_HOST)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        );
    if let Some(len) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, len);
    }
    builder.body(Body::from(body)).unwrap()
}

#[tokio::test]
async fn host_mismatch_is_rejected_with_421() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));

    for (host, path) in [
        (Some("evil.example.com"), "/healthz"),
        (Some("evil.example.com"), "/mint"),
        (None, "/healthz"),
    ] {
        let mut builder = Request::builder().method("GET").uri(path);
        if let Some(host) = host {
            builder = builder.header(header::HOST, host);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::MISDIRECTED_REQUEST,
            "host={host:?} path={path}"
        );
    }
}

#[tokio::test]
async fn host_match_is_case_insensitive() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/healthz")
                .header(header::HOST, "UPLOADS.Test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn mint_without_token_is_401() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mint")
                .header(header::HOST, ALLOWED_HOST)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn mint_with_invalid_token_is_401() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let mut request = mint_request("{}");
    request.headers_mut().insert(
        header::AUTHORIZATION,
        "Token wrong-token".parse().unwrap(),
    );
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn mint_when_paperless_is_down_is_502() {
    // Bind and drop a listener so the port is closed.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let app = build_app(build_state(&format!("http://{addr}")));
    let response = app.oneshot(mint_request("{}")).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn mint_falls_back_when_profile_endpoint_is_missing() {
    let (paperless, _) = start_mock_paperless(true).await;
    let app = build_app(build_state(&paperless));
    let response = app.oneshot(mint_request("{}")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn mint_clamps_limits_and_returns_capability_url() {
    let (paperless, _) = start_mock_paperless(false).await;
    let state = build_state(&paperless);
    let app = build_app(state.clone());

    let minted = mint(
        &app,
        r#"{"max_bytes": 999999999999, "ttl_seconds": 999999}"#,
    )
    .await;

    assert_eq!(
        minted["max_bytes"].as_u64().unwrap(),
        state.config.max_bytes_ceiling
    );
    let url = minted["upload_url"].as_str().unwrap();
    assert!(url.starts_with(&format!("https://{ALLOWED_HOST}/upload/")));
    let id = url.rsplit('/').next().unwrap();
    assert_eq!(id.len(), 43); // 256-bit base64url unpadded
    assert!(minted["curl_example"].as_str().unwrap().contains(url));
    assert!(minted["expires_at"].as_str().unwrap().ends_with('Z'));
}

#[tokio::test]
async fn mint_stores_no_plaintext_token() {
    let (paperless, _) = start_mock_paperless(false).await;
    let state = build_state(&paperless);
    let app = build_app(state.clone());
    mint(&app, "{}").await;

    let records = state.store.enc_tokens_for_test();
    assert_eq!(records.len(), 1);
    assert!(!records[0]
        .windows(GOOD_TOKEN.len())
        .any(|w| w == GOOD_TOKEN.as_bytes()));
}

#[tokio::test]
async fn mint_respects_pending_limit() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless)); // pending_limit = 3
    for _ in 0..3 {
        mint(&app, "{}").await;
    }
    let response = app.oneshot(mint_request("{}")).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn upload_forwards_file_and_metadata_to_paperless() {
    let (paperless, captured) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));

    let minted = mint(
        &app,
        r#"{"title": "Test Doc", "tags": [3, 7], "correspondent": 2, "document_type": 5, "created": "2026-07-01"}"#,
    )
    .await;
    let path = upload_path(&minted);

    let content = b"%PDF-1.4 fake pdf content";
    let body = multipart_body("scan.pdf", content);
    let len = body.len() as u64;
    let response = app
        .oneshot(upload_request(&path, body, Some(len)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["status"], "ok");
    assert_eq!(json["task_id"], TASK_ID);

    let received = captured.lock().unwrap().clone().expect("upload forwarded");
    assert_eq!(received.authorization, format!("Token {GOOD_TOKEN}"));
    assert_eq!(received.filename, "scan.pdf");
    assert_eq!(received.document, content);
    let field = |name: &str| {
        received
            .fields
            .iter()
            .filter(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(field("title"), vec!["Test Doc"]);
    assert_eq!(field("tags"), vec!["3", "7"]);
    assert_eq!(field("correspondent"), vec!["2"]);
    assert_eq!(field("document_type"), vec!["5"]);
    assert_eq!(field("created"), vec!["2026-07-01"]);
}

#[tokio::test]
async fn upload_url_is_single_use() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let minted = mint(&app, "{}").await;
    let path = upload_path(&minted);

    let body = multipart_body("a.pdf", b"content");
    let len = body.len() as u64;
    let first = app
        .clone()
        .oneshot(upload_request(&path, body.clone(), Some(len)))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);

    let second = app
        .oneshot(upload_request(&path, body, Some(len)))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn upload_with_unknown_id_is_403() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let body = multipart_body("a.pdf", b"content");
    let len = body.len() as u64;
    let response = app
        .oneshot(upload_request(
            "/upload/does-not-exist",
            body,
            Some(len),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn upload_after_expiry_is_403() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let minted = mint(&app, r#"{"ttl_seconds": 0}"#).await;
    let path = upload_path(&minted);

    let body = multipart_body("a.pdf", b"content");
    let len = body.len() as u64;
    let response = app
        .oneshot(upload_request(&path, body, Some(len)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn upload_over_content_length_limit_is_413() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let minted = mint(&app, r#"{"max_bytes": 10}"#).await;
    let path = upload_path(&minted);

    let body = multipart_body("a.pdf", &[b'x'; 64]);
    let len = body.len() as u64;
    let response = app
        .oneshot(upload_request(&path, body, Some(len)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn upload_without_content_length_is_413() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let minted = mint(&app, "{}").await;
    let path = upload_path(&minted);

    let body = multipart_body("a.pdf", b"content");
    let response = app
        .oneshot(upload_request(&path, body, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn upload_streamed_bytes_backstop_aborts_lying_content_length() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    // max_bytes larger than the claimed Content-Length but smaller than the
    // actual file, so only the streamed-byte counter can catch it.
    let minted = mint(&app, r#"{"max_bytes": 100}"#).await;
    let path = upload_path(&minted);

    let body = multipart_body("a.pdf", &[b'x'; 4096]);
    let response = app
        .oneshot(upload_request(&path, body, Some(50)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn upload_without_document_field_is_400() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let minted = mint(&app, "{}").await;
    let path = upload_path(&minted);

    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"other\"\r\n\r\nvalue\r\n--{BOUNDARY}--\r\n"
        )
        .as_bytes(),
    );
    let len = body.len() as u64;
    let response = app
        .oneshot(upload_request(&path, body, Some(len)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn healthz_returns_ok() {
    let (paperless, _) = start_mock_paperless(false).await;
    let app = build_app(build_state(&paperless));
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/healthz")
                .header(header::HOST, ALLOWED_HOST)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
