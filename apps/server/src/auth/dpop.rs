use std::{collections::HashMap, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, VerifyingKey, signature::hazmat::PrehashVerifier};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use super::{secret_store::SecretStore, service::AuthError};

const MAX_AGE_SECONDS: i64 = 300;
const FUTURE_SKEW_SECONDS: i64 = 5;
const MAX_IN_MEMORY_REPLAY_ENTRIES: usize = 4_096;
const PERSISTENT_REPLAY_PREFIX: &str = "dpop-proof";
const PERSISTENT_CLEANUP_INTERVAL_SECONDS: i64 = 60;

#[derive(Clone, Default)]
pub struct DpopVerifier {
    replay: Arc<Mutex<HashMap<String, i64>>>,
    replay_store: Option<SecretStore>,
    persistent_replay: Arc<Mutex<PersistentReplayState>>,
}

#[derive(Default)]
struct PersistentReplayState {
    initialized: bool,
    active_count: usize,
    next_cleanup_at: i64,
}

#[derive(Debug, Deserialize)]
struct DpopHeader {
    typ: String,
    alg: String,
    jwk: PublicJwk,
}

#[derive(Debug, Deserialize)]
struct PublicJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
    d: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct DpopPayload {
    htm: String,
    htu: String,
    jti: String,
    iat: i64,
    ath: Option<String>,
}

impl DpopVerifier {
    #[must_use]
    pub fn new(replay_store: Option<SecretStore>) -> Self {
        Self {
            replay: Arc::default(),
            replay_store,
            persistent_replay: Arc::default(),
        }
    }

    pub async fn verify(
        &self,
        proof: &str,
        method: &str,
        url: &str,
        now_seconds: i64,
        expected_thumbprint: Option<&str>,
        expected_access_token: Option<&str>,
    ) -> Result<String, AuthError> {
        let mut parts = proof.split('.');
        let (Some(header), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(AuthError::InvalidCredential);
        };
        if header.is_empty() || payload.is_empty() || signature.is_empty() {
            return Err(AuthError::InvalidCredential);
        }
        let header_value: DpopHeader = decode_json_part(header)?;
        let payload_value: DpopPayload = decode_json_part(payload)?;
        if header_value.typ != "dpop+jwt"
            || header_value.alg != "ES256"
            || header_value.jwk.kty != "EC"
            || header_value.jwk.crv != "P-256"
            || header_value.jwk.d.is_some()
            || payload_value.htm.trim().is_empty()
            || payload_value.htu.trim().is_empty()
            || payload_value.jti.trim().is_empty()
        {
            return Err(AuthError::InvalidCredential);
        }
        let thumbprint = jwk_thumbprint(&header_value.jwk);
        if expected_thumbprint.is_some_and(|expected| expected != thumbprint) {
            return Err(AuthError::InvalidCredential);
        }
        if !payload_value.htm.eq_ignore_ascii_case(method) {
            return Err(AuthError::InvalidCredential);
        }
        let expected_url = normalize_htu(url).ok_or(AuthError::InvalidCredential)?;
        if payload_value.htu != expected_url {
            return Err(AuthError::InvalidCredential);
        }
        if let Some(access_token) = expected_access_token {
            let expected_ath = URL_SAFE_NO_PAD.encode(Sha256::digest(access_token.as_bytes()));
            if payload_value.ath.as_deref() != Some(expected_ath.as_str()) {
                return Err(AuthError::InvalidCredential);
            }
        }
        if payload_value.iat > now_seconds.saturating_add(FUTURE_SKEW_SECONDS)
            || now_seconds.saturating_sub(payload_value.iat) > MAX_AGE_SECONDS
        {
            return Err(AuthError::InvalidCredential);
        }
        verify_signature(&header_value.jwk, header, payload, signature)?;

        let replay_key = format!("{thumbprint}:{}", payload_value.jti);
        if let Some(store) = &self.replay_store {
            let replay_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(replay_key.as_bytes()));
            let replay_name = format!("{PERSISTENT_REPLAY_PREFIX}-{replay_digest}");
            let replay_record = format!(
                "thumbprint={thumbprint}\njti={}\niat={}\nconsumedAt={now_seconds}\n",
                payload_value.jti, payload_value.iat
            );
            self.reserve_persistent_replay(store, &replay_name, &replay_record, now_seconds)
                .await?;
            return Ok(thumbprint);
        }
        let mut replay = self.replay.lock().await;
        replay.retain(|_, expires_at| *expires_at > now_seconds);
        if replay.contains_key(&replay_key) {
            return Err(AuthError::InvalidCredential);
        }
        if replay.len() >= MAX_IN_MEMORY_REPLAY_ENTRIES {
            return Err(AuthError::Internal(
                "DPoP replay window capacity exceeded".to_owned(),
            ));
        }
        replay.insert(replay_key, now_seconds.saturating_add(MAX_AGE_SECONDS));
        Ok(thumbprint)
    }

    async fn reserve_persistent_replay(
        &self,
        store: &SecretStore,
        replay_name: &str,
        replay_record: &str,
        now_seconds: i64,
    ) -> Result<(), AuthError> {
        let mut state = self.persistent_replay.lock().await;
        if !state.initialized
            || now_seconds >= state.next_cleanup_at
            || state.active_count >= MAX_IN_MEMORY_REPLAY_ENTRIES
        {
            state.active_count = store
                .prune_records_with_prefix(PERSISTENT_REPLAY_PREFIX, |record| {
                    replay_record_expired(record, now_seconds)
                })
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            state.initialized = true;
            state.next_cleanup_at = now_seconds.saturating_add(PERSISTENT_CLEANUP_INTERVAL_SECONDS);
        }
        if state.active_count >= MAX_IN_MEMORY_REPLAY_ENTRIES {
            return Err(AuthError::Internal(
                "DPoP replay window capacity exceeded".to_owned(),
            ));
        }
        match store.create(replay_name, replay_record.as_bytes()).await {
            Ok(()) => {
                state.active_count = state.active_count.saturating_add(1);
                Ok(())
            }
            Err(error) if error.is_already_exists() => Err(AuthError::InvalidCredential),
            Err(error) => Err(AuthError::Internal(error.to_string())),
        }
    }
}

fn replay_record_expired(record: &[u8], now_seconds: i64) -> bool {
    let Some(issued_at) = std::str::from_utf8(record).ok().and_then(|record| {
        record
            .lines()
            .find_map(|line| line.strip_prefix("iat="))
            .and_then(|value| value.parse::<i64>().ok())
    }) else {
        return true;
    };
    issued_at
        .saturating_add(MAX_AGE_SECONDS)
        .saturating_add(FUTURE_SKEW_SECONDS)
        <= now_seconds
}

fn decode_json_part<T: for<'de> Deserialize<'de>>(part: &str) -> Result<T, AuthError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| AuthError::InvalidCredential)?;
    serde_json::from_slice(&bytes).map_err(|_| AuthError::InvalidCredential)
}

fn jwk_thumbprint(jwk: &PublicJwk) -> String {
    let input = format!(
        "{{\"crv\":\"{}\",\"kty\":\"{}\",\"x\":\"{}\",\"y\":\"{}\"}}",
        jwk.crv, jwk.kty, jwk.x, jwk.y
    );
    URL_SAFE_NO_PAD.encode(Sha256::digest(input.as_bytes()))
}

fn verify_signature(
    jwk: &PublicJwk,
    header: &str,
    payload: &str,
    encoded_signature: &str,
) -> Result<(), AuthError> {
    let x = URL_SAFE_NO_PAD
        .decode(&jwk.x)
        .map_err(|_| AuthError::InvalidCredential)?;
    let y = URL_SAFE_NO_PAD
        .decode(&jwk.y)
        .map_err(|_| AuthError::InvalidCredential)?;
    if x.len() != 32 || y.len() != 32 {
        return Err(AuthError::InvalidCredential);
    }
    let mut point = Vec::with_capacity(65);
    point.push(4);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    let key = VerifyingKey::from_sec1_bytes(&point).map_err(|_| AuthError::InvalidCredential)?;
    let signature = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or(AuthError::InvalidCredential)?;
    let digest = Sha256::digest(format!("{header}.{payload}").as_bytes());
    key.verify_prehash(&digest, &signature)
        .map_err(|_| AuthError::InvalidCredential)
}

fn normalize_htu(value: &str) -> Option<String> {
    let mut url = Url::parse(value).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn persistent_replay_records_are_pruned_and_counted_on_first_use() {
        let temp = TempDir::new().expect("temporary replay directory");
        let store = SecretStore::new(temp.path().join("secrets"))
            .await
            .expect("replay secret store");
        store
            .create(
                "dpop-proof-expired",
                b"thumbprint=old\njti=old\niat=100\nconsumedAt=100\n",
            )
            .await
            .expect("expired replay record");
        store
            .create(
                "dpop-proof-active",
                b"thumbprint=new\njti=active\niat=950\nconsumedAt=950\n",
            )
            .await
            .expect("active replay record");
        let verifier = DpopVerifier::new(Some(store.clone()));

        verifier
            .reserve_persistent_replay(
                &store,
                "dpop-proof-new",
                "thumbprint=new\njti=new\niat=1000\nconsumedAt=1000\n",
                1_000,
            )
            .await
            .expect("reserve new replay record");

        assert_eq!(store.get("dpop-proof-expired").await.unwrap(), None);
        assert!(store.get("dpop-proof-active").await.unwrap().is_some());
        assert!(store.get("dpop-proof-new").await.unwrap().is_some());
        let state = verifier.persistent_replay.lock().await;
        assert!(state.initialized);
        assert_eq!(state.active_count, 2);
    }

    #[test]
    fn malformed_and_expired_replay_records_are_collectable() {
        assert!(replay_record_expired(b"invalid", 1_000));
        assert!(replay_record_expired(b"iat=695\n", 1_000));
        assert!(!replay_record_expired(b"iat=696\n", 1_000));
    }
}
