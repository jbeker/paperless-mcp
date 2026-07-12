use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

/// Metadata forwarded to Paperless as form fields alongside the file.
#[derive(Clone, Debug, Default, Serialize)]
pub struct UploadMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correspondent: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_type: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

pub struct PendingUpload {
    pub enc_token: Vec<u8>,
    pub meta: UploadMeta,
    pub max_bytes: u64,
    pub expires_at: Instant,
}

#[derive(Default)]
pub struct PendingStore {
    inner: Mutex<HashMap<String, PendingUpload>>,
}

impl PendingStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inserts a record unless the pending count has reached `limit`.
    pub fn insert(&self, id: String, record: PendingUpload, limit: usize) -> Result<(), ()> {
        let mut map = self.inner.lock().unwrap();
        if map.len() >= limit {
            return Err(());
        }
        map.insert(id, record);
        Ok(())
    }

    /// Removes and returns the record in one step, so a URL can never be used
    /// twice: the second caller finds nothing. Expired records are dropped on
    /// lookup and reported as absent.
    pub fn take(&self, id: &str) -> Option<PendingUpload> {
        let record = self.inner.lock().unwrap().remove(id)?;
        if record.expires_at <= Instant::now() {
            return None;
        }
        Some(record)
    }

    pub fn sweep_expired(&self) {
        let now = Instant::now();
        self.inner
            .lock()
            .unwrap()
            .retain(|_, record| record.expires_at > now);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// Test-only view of stored ciphertexts, used to assert that no plaintext
    /// token bytes are ever retained.
    #[doc(hidden)]
    pub fn enc_tokens_for_test(&self) -> Vec<Vec<u8>> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .map(|r| r.enc_token.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn record(expires_in: Duration) -> PendingUpload {
        PendingUpload {
            enc_token: vec![1, 2, 3],
            meta: UploadMeta::default(),
            max_bytes: 100,
            expires_at: Instant::now() + expires_in,
        }
    }

    #[test]
    fn take_is_single_use() {
        let store = PendingStore::new();
        store
            .insert("a".into(), record(Duration::from_secs(60)), 10)
            .unwrap();
        assert!(store.take("a").is_some());
        assert!(store.take("a").is_none());
    }

    #[test]
    fn take_rejects_expired() {
        let store = PendingStore::new();
        store
            .insert("a".into(), record(Duration::ZERO), 10)
            .unwrap();
        assert!(store.take("a").is_none());
    }

    #[test]
    fn insert_enforces_pending_limit() {
        let store = PendingStore::new();
        store
            .insert("a".into(), record(Duration::from_secs(60)), 1)
            .unwrap();
        assert!(store
            .insert("b".into(), record(Duration::from_secs(60)), 1)
            .is_err());
    }

    #[test]
    fn sweep_drops_only_expired() {
        let store = PendingStore::new();
        store
            .insert("old".into(), record(Duration::ZERO), 10)
            .unwrap();
        store
            .insert("new".into(), record(Duration::from_secs(60)), 10)
            .unwrap();
        store.sweep_expired();
        assert_eq!(store.len(), 1);
        assert!(store.take("new").is_some());
    }
}
