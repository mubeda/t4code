use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{
    Signature as Ed25519Signature, Signer as _, SigningKey as Ed25519SigningKey, Verifier as _,
};
use hmac::{Hmac, KeyInit as _, Mac};
use p256::ecdsa::{
    Signature as P256Signature, SigningKey as P256SigningKey,
    signature::hazmat::{PrehashSigner as _, PrehashVerifier as _},
};
use sha2::{Digest as _, Sha256};

type HmacSha256 = Hmac<Sha256>;

fn decode_hex<const N: usize>(input: &str) -> [u8; N] {
    assert_eq!(input.len(), N * 2, "hex fixture length");
    let mut output = [0_u8; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&input[index * 2..index * 2 + 2], 16)
            .expect("valid fixed hex fixture");
    }
    output
}

fn encode_hex(input: &[u8]) -> String {
    input.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn ed25519_rfc8032_vector_and_public_jwk_are_stable() {
    let secret = decode_hex::<32>(
        "9d61b19deffd5a60ba844af492ec2cc4\
         4449c5697b326919703bac031cae7f60",
    );
    let signing_key = Ed25519SigningKey::from_bytes(&secret);
    let verifying_key = signing_key.verifying_key();

    assert_eq!(
        encode_hex(verifying_key.as_bytes()),
        "d75a980182b10ab7d54bfed3c964073a\
         0ee172f3daa62325af021a68f707511a"
            .replace(' ', "")
    );
    assert_eq!(
        URL_SAFE_NO_PAD.encode(verifying_key.as_bytes()),
        "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
    );

    let signature = signing_key.sign(b"");
    assert_eq!(
        encode_hex(&signature.to_bytes()),
        "e5564300c360ac729086e2cc806e828a\
         84877f1eb8e5d974d873e06522490155\
         5fb8821590a33bacc61e39701cf9b46b\
         d25bf5f0595bbe24655141438e7a100b"
            .replace(' ', "")
    );
    verifying_key
        .verify(b"", &signature)
        .expect("RFC 8032 signature verifies");

    let malformed = Ed25519Signature::from_slice(&[0_u8; 64]).expect("64-byte signature");
    assert!(verifying_key.verify(b"", &malformed).is_err());
    assert!(Ed25519Signature::from_slice(&[0_u8; 63]).is_err());
}

#[test]
fn p256_dpop_key_and_deterministic_signature_are_stable() {
    let mut secret = [0_u8; 32];
    secret[31] = 1;
    let signing_key = P256SigningKey::from_slice(&secret).expect("valid P-256 scalar");
    let verifying_key = signing_key.verifying_key();
    let public_point = verifying_key.to_sec1_point(false);

    assert_eq!(
        encode_hex(public_point.as_bytes()),
        "046b17d1f2e12c4247f8bce6e563a440\
         f277037d812deb33a0f4a13945d898c296\
         4fe342e2fe1a7f9b8ee7eb4a7c0f9e16\
         2bce33576b315ececbb6406837bf51f5"
            .replace(' ', "")
    );

    let signing_input = b"eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.\
        eyJqdGkiOiJmaXhlZC1qdGkiLCJodG0iOiJHRVQiLCJodHUiOiJodHRwczovL2V4YW1wbGUuY29tIn0";
    let digest = Sha256::digest(signing_input);
    let signature: P256Signature = signing_key
        .sign_prehash(&digest)
        .expect("sign fixed DPoP prehash");
    verifying_key
        .verify_prehash(&digest, &signature)
        .expect("verify fixed DPoP prehash");
    assert_eq!(
        encode_hex(&signature.to_bytes()),
        "ad3527305c7f882f640d871e77b7dc3d\
         35abfca65fa639efb12362cafcaced1c\
         dec2e4a9299433eb3d695b964cdc242\
         627393a1779354b46a69c4b8153f4fa27"
            .replace(' ', "")
    );
}

#[test]
fn sha256_hmac_and_os_random_apis_remain_compatible() {
    assert_eq!(
        encode_hex(&Sha256::digest(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223\
         b00361a396177a9cb410ff61f20015ad"
            .replace(' ', "")
    );

    let mut mac =
        HmacSha256::new_from_slice(&[0x0b; 20]).expect("HMAC accepts secrets of any length");
    mac.update(b"Hi There");
    assert_eq!(
        encode_hex(&mac.finalize().into_bytes()),
        "b0344c61d8db38535ca8afceaf0bf12b\
         881dc200c9833da726e9376c2e32cff7"
            .replace(' ', "")
    );

    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).expect("operating-system randomness");
    assert_ne!(random, [0_u8; 32]);
}
