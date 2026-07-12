use std::sync::Arc;
use std::time::Duration;

use paperless_upload_proxy::config::Config;
use paperless_upload_proxy::crypto::ProcessKey;
use paperless_upload_proxy::handlers::{build_app, AppState};
use paperless_upload_proxy::state::PendingStore;

fn disable_core_dumps() {
    let limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let rc = unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) };
    if rc != 0 {
        tracing::warn!("could not disable core dumps (setrlimit failed); continuing");
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuration error: {e}");
            std::process::exit(1);
        }
    };

    disable_core_dumps();

    let state = Arc::new(AppState {
        key: ProcessKey::generate(),
        store: PendingStore::new(),
        http: reqwest::Client::new(),
        config: config.clone(),
    });

    let sweeper = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            sweeper.store.sweep_expired();
        }
    });

    let app = build_app(state);
    let listener = match tokio::net::TcpListener::bind(&config.listen_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot bind {}: {e}", config.listen_addr);
            std::process::exit(1);
        }
    };
    tracing::info!(
        listen_addr = %config.listen_addr,
        allowed_host = %config.allowed_host,
        paperless_url = %config.paperless_url,
        max_bytes_ceiling = config.max_bytes_ceiling,
        pending_limit = config.pending_limit,
        "paperless-upload-proxy started with a fresh process key"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
