use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use zeroize::{Zeroize, Zeroizing};

const NONCE_LEN: usize = 24;

/// Ephemeral per-process key. Generated from the OS CSPRNG at startup, never
/// persisted or configurable; a restart makes all prior ciphertext
/// undecryptable by design.
pub struct ProcessKey {
    cipher: XChaCha20Poly1305,
    #[allow(dead_code)]
    raw: Zeroizing<[u8; 32]>,
}

impl ProcessKey {
    pub fn generate() -> Self {
        let mut raw = Zeroizing::new([0u8; 32]);
        getrandom::fill(raw.as_mut()).expect("OS CSPRNG unavailable");
        let cipher = XChaCha20Poly1305::new(raw.as_ref().into());
        // Best-effort: keep the key page out of swap. The cipher retains its
        // own key schedule copy, so this covers the raw bytes we hold.
        unsafe {
            let _ = libc::mlock(raw.as_ptr() as *const libc::c_void, raw.len());
        }
        ProcessKey { cipher, raw }
    }

    /// Encrypts `plaintext` with a fresh random nonce, binding the ciphertext
    /// to `aad` (the upload_id) so records cannot be swapped. Returns
    /// nonce-prefixed ciphertext.
    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce_bytes).expect("OS CSPRNG unavailable");
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, Payload { msg: plaintext, aad })
            .expect("AEAD encryption cannot fail with valid key and nonce");
        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        out
    }

    /// Decrypts nonce-prefixed ciphertext produced by `seal`. The returned
    /// buffer zeroizes itself on drop.
    pub fn open(&self, sealed: &[u8], aad: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        if sealed.len() <= NONCE_LEN {
            return None;
        }
        let (nonce_bytes, ciphertext) = sealed.split_at(NONCE_LEN);
        let nonce = XNonce::from_slice(nonce_bytes);
        self.cipher
            .decrypt(nonce, Payload { msg: ciphertext, aad })
            .ok()
            .map(Zeroizing::new)
    }
}

/// Generates a 256-bit random upload ID, base64url-encoded without padding.
pub fn generate_upload_id() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS CSPRNG unavailable");
    let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    bytes.zeroize();
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = ProcessKey::generate();
        let sealed = key.seal(b"secret-token", b"upload-id-1");
        let opened = key.open(&sealed, b"upload-id-1").expect("decrypts");
        assert_eq!(opened.as_slice(), b"secret-token");
    }

    #[test]
    fn open_fails_with_wrong_aad() {
        let key = ProcessKey::generate();
        let sealed = key.seal(b"secret-token", b"upload-id-1");
        assert!(key.open(&sealed, b"upload-id-2").is_none());
    }

    #[test]
    fn sealed_record_contains_no_plaintext() {
        let key = ProcessKey::generate();
        let token = b"paperless-token-abcdef";
        let sealed = key.seal(token, b"upload-id-1");
        assert!(!sealed
            .windows(token.len())
            .any(|w| w == token.as_slice()));
    }

    #[test]
    fn different_keys_cannot_decrypt() {
        let key_a = ProcessKey::generate();
        let key_b = ProcessKey::generate();
        let sealed = key_a.seal(b"secret-token", b"id");
        assert!(key_b.open(&sealed, b"id").is_none());
    }

    #[test]
    fn upload_id_is_urlsafe_and_long() {
        let id = generate_upload_id();
        assert_eq!(id.len(), 43); // 32 bytes base64url unpadded
        assert!(id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
