use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit as _, Mac};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::Sha256;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct TokenSigner {
    secret: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum TokenError {
    #[error("token is malformed")]
    Malformed,
    #[error("token signature is invalid")]
    InvalidSignature,
    #[error("token payload is invalid")]
    InvalidPayload,
    #[error("failed to encode token payload")]
    Encode(#[source] serde_json::Error),
}

impl TokenSigner {
    #[must_use]
    pub fn new(secret: Vec<u8>) -> Self {
        Self { secret }
    }

    pub fn issue<T: Serialize>(&self, claims: &T) -> Result<String, TokenError> {
        let payload = serde_json::to_vec(claims).map_err(TokenError::Encode)?;
        let encoded_payload = URL_SAFE_NO_PAD.encode(payload);
        let signature = self.signature(encoded_payload.as_bytes());
        Ok(format!(
            "{encoded_payload}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        ))
    }

    pub fn verify<T: DeserializeOwned>(&self, token: &str) -> Result<T, TokenError> {
        let mut parts = token.split('.');
        let encoded_payload = parts.next().filter(|part| !part.is_empty());
        let encoded_signature = parts.next().filter(|part| !part.is_empty());
        let (Some(encoded_payload), Some(encoded_signature)) = (encoded_payload, encoded_signature)
        else {
            return Err(TokenError::Malformed);
        };
        let signature = URL_SAFE_NO_PAD
            .decode(encoded_signature)
            .map_err(|_| TokenError::InvalidSignature)?;
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts secrets of any length");
        mac.update(encoded_payload.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| TokenError::InvalidSignature)?;
        let payload = URL_SAFE_NO_PAD
            .decode(encoded_payload)
            .map_err(|_| TokenError::InvalidPayload)?;
        serde_json::from_slice(&payload).map_err(|_| TokenError::InvalidPayload)
    }

    fn signature(&self, payload: &[u8]) -> Vec<u8> {
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts secrets of any length");
        mac.update(payload);
        mac.finalize().into_bytes().to_vec()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionClaims {
    pub v: u8,
    pub kind: String,
    pub sid: String,
    pub sub: String,
    pub scopes: Vec<String>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jkt: Option<String>,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebSocketClaims {
    pub v: u8,
    pub kind: String,
    pub sid: String,
    pub iat: i64,
    pub exp: i64,
}
