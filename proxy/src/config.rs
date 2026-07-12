use std::env;

pub const DEFAULT_MAX_BYTES: u64 = 104_857_600;
pub const DEFAULT_TTL_SECONDS: u64 = 900;
pub const MAX_TTL_SECONDS: u64 = 3600;

#[derive(Clone, Debug)]
pub struct Config {
    pub paperless_url: String,
    pub allowed_host: String,
    pub listen_addr: String,
    pub max_bytes_ceiling: u64,
    pub pending_limit: usize,
    /// Scheme used when building returned upload URLs. Defaults to "https"
    /// (production sits behind a TLS-terminating reverse proxy); "http" exists
    /// for test stacks without one.
    pub public_scheme: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let paperless_url = env::var("PAPERLESS_URL")
            .map_err(|_| "PAPERLESS_URL is required".to_string())?
            .trim_end_matches('/')
            .to_string();
        let allowed_host = env::var("ALLOWED_HOST")
            .map_err(|_| "ALLOWED_HOST is required".to_string())?
            .trim()
            .to_ascii_lowercase();
        if allowed_host.is_empty() {
            return Err("ALLOWED_HOST must not be empty".to_string());
        }
        let listen_addr =
            env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let max_bytes_ceiling = match env::var("MAX_BYTES_CEILING") {
            Ok(v) => v
                .parse::<u64>()
                .map_err(|_| format!("MAX_BYTES_CEILING is not a number: {v}"))?,
            Err(_) => DEFAULT_MAX_BYTES,
        };
        let pending_limit = match env::var("PENDING_LIMIT") {
            Ok(v) => v
                .parse::<usize>()
                .map_err(|_| format!("PENDING_LIMIT is not a number: {v}"))?,
            Err(_) => 100,
        };
        let public_scheme = env::var("PUBLIC_SCHEME").unwrap_or_else(|_| "https".to_string());
        if public_scheme != "https" && public_scheme != "http" {
            return Err(format!("PUBLIC_SCHEME must be http or https, got: {public_scheme}"));
        }
        Ok(Config {
            paperless_url,
            allowed_host,
            listen_addr,
            max_bytes_ceiling,
            pending_limit,
            public_scheme,
        })
    }
}
