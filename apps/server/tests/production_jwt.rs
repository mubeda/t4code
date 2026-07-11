#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{VerifyingKey, pkcs8::DecodePublicKey};
use serde_json::{Value, json};
use tempfile::TempDir;

use t4code_server::production::jwt::PersistentJwtCodec;

const NOW: i64 = 1_800_000_000;
const TYP: &str = "t4code-cloud-mint+jwt";
const ISSUER: &str = "https://relay.example";
const AUDIENCE: &str = "t4code-env:environment-1";

fn proof_claims() -> Value {
    json!({
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": "cloud-user-1",
        "jti": "proof-id-1",
        "iat": NOW,
        "exp": NOW + 300,
        "environmentId": "environment-1",
        "nonce": "nonce-1",
        "scope": ["environment:connect"],
        "clientProofKeyThumbprint": "proof-key-thumbprint",
        "cnf": { "jkt": "proof-key-thumbprint" }
    })
}

fn public_jwk(public_pem: &str) -> String {
    let key = VerifyingKey::from_public_key_pem(public_pem).expect("valid public PEM");
    json!({
        "kty": "OKP",
        "crv": "Ed25519",
        "x": URL_SAFE_NO_PAD.encode(key.as_bytes()),
        "alg": "EdDSA",
        "use": "sig"
    })
    .to_string()
}

fn token_header(token: &str) -> Value {
    let encoded = token.split('.').next().expect("JWT header");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).expect("base64url header"))
        .expect("JSON header")
}

#[tokio::test]
async fn persists_one_restrictive_atomic_ed25519_identity_across_restarts() {
    let temp = TempDir::new().expect("temporary directory");
    let path = temp.path().join("secrets/environment-signing-key.json");

    let first = PersistentJwtCodec::open(&path).await.expect("first open");
    let first_pair = first.key_pair().await.expect("first key pair");
    let second = PersistentJwtCodec::open(&path).await.expect("second open");
    let second_pair = second.key_pair().await.expect("second key pair");

    assert_eq!(first_pair, second_pair);
    assert!(first_pair.0.contains("BEGIN PRIVATE KEY"));
    assert!(first_pair.1.contains("BEGIN PUBLIC KEY"));
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap())
            .expect("key directory")
            .count(),
        1,
        "atomic persistence must not leave temporary artifacts"
    );

    #[cfg(unix)]
    {
        let directory_mode = std::fs::metadata(path.parent().unwrap())
            .expect("directory metadata")
            .permissions()
            .mode()
            & 0o777;
        let file_mode = std::fs::metadata(&path)
            .expect("file metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }
}

#[tokio::test]
async fn signs_typed_eddsa_jwts_and_produces_connect_mcp_callbacks() {
    let temp = TempDir::new().expect("temporary directory");
    let codec = PersistentJwtCodec::open(temp.path().join("keypair.json"))
        .await
        .expect("codec");

    let token = codec.sign(TYP, proof_claims()).await.expect("signed JWT");
    assert_eq!(token_header(&token), json!({ "alg": "EdDSA", "typ": TYP }));
    let _callbacks: t4code_server::production::connect_mcp::JwtCodec = codec.jwt_codec();
}

#[tokio::test]
async fn verifies_spki_pem_and_ed25519_public_jwk_into_typed_cloud_proof() {
    let temp = TempDir::new().expect("temporary directory");
    let codec = PersistentJwtCodec::open(temp.path().join("keypair.json"))
        .await
        .expect("codec");
    let (_, public_pem) = codec.key_pair().await.expect("key pair");
    let token = codec.sign(TYP, proof_claims()).await.expect("signed JWT");

    for public_key in [public_pem.clone(), public_jwk(&public_pem)] {
        let proof = codec
            .verify(public_key, TYP, token.clone(), ISSUER, AUDIENCE, NOW)
            .await
            .expect("verified proof");
        assert_eq!(proof.issuer, ISSUER);
        assert_eq!(proof.subject, "cloud-user-1");
        assert_eq!(proof.jwt_id, "proof-id-1");
        assert_eq!(proof.scope, ["environment:connect"]);
        assert_eq!(
            proof.client_proof_key_thumbprint.as_deref(),
            Some("proof-key-thumbprint")
        );
        assert_eq!(
            proof.confirmation_thumbprint,
            proof.client_proof_key_thumbprint
        );
    }
}

#[tokio::test]
async fn rejects_tampering_and_invalid_registered_claims() {
    let temp = TempDir::new().expect("temporary directory");
    let codec = PersistentJwtCodec::open(temp.path().join("keypair.json"))
        .await
        .expect("codec");
    let (_, public_pem) = codec.key_pair().await.expect("key pair");

    let valid = codec.sign(TYP, proof_claims()).await.expect("signed JWT");
    let mut tampered = valid.clone().into_bytes();
    let signature_start = valid.rfind('.').expect("signature separator") + 1;
    tampered[signature_start] = if tampered[signature_start] == b'A' {
        b'B'
    } else {
        b'A'
    };
    let tampered = String::from_utf8(tampered).expect("ASCII JWT");

    let invalid_cases = [
        (tampered, TYP, ISSUER, AUDIENCE, NOW),
        (valid.clone(), "wrong+jwt", ISSUER, AUDIENCE, NOW),
        (valid.clone(), TYP, "https://wrong.example", AUDIENCE, NOW),
        (valid.clone(), TYP, ISSUER, "wrong-audience", NOW),
        (valid.clone(), TYP, ISSUER, AUDIENCE, NOW + 361),
    ];
    for (token, typ, issuer, audience, now) in invalid_cases {
        assert!(
            codec
                .verify(public_pem.clone(), typ, token, issuer, audience, now)
                .await
                .is_err()
        );
    }

    let mut future = proof_claims();
    future["iat"] = json!(NOW + 61);
    future["exp"] = json!(NOW + 120);
    let future = codec.sign(TYP, future).await.expect("signed future JWT");
    assert!(
        codec
            .verify(public_pem.clone(), TYP, future, ISSUER, AUDIENCE, NOW)
            .await
            .is_err()
    );

    let mut missing_jti = proof_claims();
    missing_jti.as_object_mut().unwrap().remove("jti");
    assert!(codec.sign(TYP, missing_jti).await.is_err());
}
