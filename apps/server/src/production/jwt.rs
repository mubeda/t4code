use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::{
    Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey,
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::fs;

use crate::{
    persistence::write_json_atomically,
    production::connect_mcp::{DecodedCloudProof, JwtCodec},
};

const KEYPAIR_VERSION: u8 = 1;
const CLOCK_SKEW_SECONDS: i64 = 60;
const MAX_TOKEN_AGE_SECONDS: i64 = 5 * 60;

#[derive(Debug, Error)]
pub enum PersistentJwtError {
    #[error("failed to read JWT keypair {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to decode JWT keypair {path}: {message}")]
    Decode { path: PathBuf, message: String },
    #[error("failed to persist JWT keypair {path}: {message}")]
    Persist { path: PathBuf, message: String },
    #[error("failed to restrict JWT keypair path {path}")]
    Permissions {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("JWT operation failed: {0}")]
    Jwt(String),
}

#[derive(Clone)]
pub struct PersistentJwtCodec {
    key_pair: Arc<StoredKeyPair>,
}

#[derive(Clone)]
struct StoredKeyPair {
    private_pem: String,
    public_pem: String,
    signing_key: SigningKey,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyPairFile {
    version: u8,
    private_key: String,
    public_key: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct JoseHeader {
    alg: String,
    typ: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudProofClaims {
    iss: String,
    sub: String,
    aud: String,
    jti: String,
    iat: i64,
    exp: i64,
    environment_id: String,
    nonce: String,
    scope: Vec<String>,
    client_proof_key_thumbprint: Option<String>,
    cnf: Option<ConfirmationClaim>,
}

#[derive(Deserialize)]
struct ConfirmationClaim {
    jkt: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicJwk {
    kty: String,
    crv: String,
    x: String,
    #[serde(default)]
    alg: Option<String>,
    #[serde(default, rename = "use")]
    key_use: Option<String>,
}

#[derive(Deserialize)]
struct RegisteredClaims {
    iss: String,
    sub: String,
    aud: String,
    jti: String,
    iat: i64,
    exp: i64,
}

impl PersistentJwtCodec {
    pub async fn open(path: impl Into<PathBuf>) -> Result<Self, PersistentJwtError> {
        let path = path.into();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)
            .await
            .map_err(|source| PersistentJwtError::Permissions {
                path: parent.to_path_buf(),
                source,
            })?;
        secure_directory(parent)
            .await
            .map_err(|source| PersistentJwtError::Permissions {
                path: parent.to_path_buf(),
                source,
            })?;

        let record = match fs::read(&path).await {
            Ok(bytes) => decode_keypair_file(&path, &bytes)?,
            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                let record = generate_keypair()?;
                write_json_atomically(&path, &record)
                    .await
                    .map_err(|error| PersistentJwtError::Persist {
                        path: path.clone(),
                        message: error.to_string(),
                    })?;
                record
            }
            Err(source) => {
                return Err(PersistentJwtError::Read {
                    path: path.clone(),
                    source,
                });
            }
        };
        secure_file(&path)
            .await
            .map_err(|source| PersistentJwtError::Permissions {
                path: path.clone(),
                source,
            })?;

        Ok(Self {
            key_pair: Arc::new(validate_keypair_file(&path, record)?),
        })
    }

    #[must_use]
    pub fn jwt_codec(&self) -> JwtCodec {
        let signer = self.clone();
        let verifier = self.clone();
        let keys = self.clone();
        JwtCodec::new(
            move |typ, payload| {
                let signer = signer.clone();
                async move {
                    signer
                        .sign(&typ, payload)
                        .await
                        .map_err(|error| error.to_string())
                }
            },
            move |key, typ, token, issuer, audience, now| {
                let verifier = verifier.clone();
                async move {
                    verifier
                        .verify(key, &typ, token, &issuer, &audience, now)
                        .await
                        .map_err(|error| error.to_string())
                }
            },
            move || {
                let keys = keys.clone();
                async move { keys.key_pair().await.map_err(|error| error.to_string()) }
            },
        )
    }

    pub async fn key_pair(&self) -> Result<(String, String), PersistentJwtError> {
        Ok((
            self.key_pair.private_pem.clone(),
            self.key_pair.public_pem.clone(),
        ))
    }

    pub async fn sign(&self, typ: &str, payload: Value) -> Result<String, PersistentJwtError> {
        validate_typ(typ)?;
        let registered: RegisteredClaims =
            serde_json::from_value(payload.clone()).map_err(|error| {
                PersistentJwtError::Jwt(format!("invalid registered claims: {error}"))
            })?;
        validate_registered_claims(&registered)?;

        let header = serde_json::to_vec(&JoseHeader {
            alg: "EdDSA".to_owned(),
            typ: typ.to_owned(),
        })
        .map_err(jwt_error)?;
        let claims = serde_json::to_vec(&payload).map_err(jwt_error)?;
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(claims)
        );
        let signature = self.key_pair.signing_key.sign(signing_input.as_bytes());
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn verify(
        &self,
        public_key: String,
        typ: &str,
        token: String,
        issuer: &str,
        audience: &str,
        now_epoch_seconds: i64,
    ) -> Result<DecodedCloudProof, PersistentJwtError> {
        validate_typ(typ)?;
        let mut segments = token.split('.');
        let encoded_header = segments
            .next()
            .ok_or_else(|| jwt("JWT header is missing"))?;
        let encoded_claims = segments
            .next()
            .ok_or_else(|| jwt("JWT claims are missing"))?;
        let encoded_signature = segments
            .next()
            .ok_or_else(|| jwt("JWT signature is missing"))?;
        if segments.next().is_some() {
            return Err(jwt("JWT must contain exactly three segments"));
        }

        let header: JoseHeader = decode_json_segment(encoded_header, "header")?;
        if header.alg != "EdDSA" || header.typ != typ {
            return Err(jwt(
                "JWT protected header does not match EdDSA and the required typ",
            ));
        }
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(encoded_signature)
            .map_err(|error| jwt(format!("invalid JWT signature encoding: {error}")))?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|error| jwt(format!("invalid Ed25519 signature: {error}")))?;
        let verifying_key = decode_public_key(&public_key)?;
        verifying_key
            .verify(
                format!("{encoded_header}.{encoded_claims}").as_bytes(),
                &signature,
            )
            .map_err(|_| jwt("JWT signature verification failed"))?;

        let claims: CloudProofClaims = decode_json_segment(encoded_claims, "claims")?;
        validate_cloud_claims(&claims, issuer, audience, now_epoch_seconds)?;
        Ok(DecodedCloudProof {
            issuer: claims.iss,
            subject: claims.sub,
            audience: claims.aud,
            jwt_id: claims.jti,
            issued_at: claims.iat,
            expires_at: claims.exp,
            environment_id: claims.environment_id,
            nonce: claims.nonce,
            scope: claims.scope,
            client_proof_key_thumbprint: claims.client_proof_key_thumbprint,
            confirmation_thumbprint: claims.cnf.map(|confirmation| confirmation.jkt),
        })
    }
}

fn generate_keypair() -> Result<KeyPairFile, PersistentJwtError> {
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret).map_err(|error| jwt(format!("key generation failed: {error}")))?;
    let signing_key = SigningKey::from_bytes(&secret);
    let private_key = signing_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(jwt_error)?
        .to_string();
    let public_key = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(jwt_error)?;
    Ok(KeyPairFile {
        version: KEYPAIR_VERSION,
        private_key,
        public_key,
    })
}

fn decode_keypair_file(path: &Path, bytes: &[u8]) -> Result<KeyPairFile, PersistentJwtError> {
    serde_json::from_slice(bytes).map_err(|error| PersistentJwtError::Decode {
        path: path.to_path_buf(),
        message: error.to_string(),
    })
}

fn validate_keypair_file(
    path: &Path,
    record: KeyPairFile,
) -> Result<StoredKeyPair, PersistentJwtError> {
    if record.version != KEYPAIR_VERSION {
        return Err(PersistentJwtError::Decode {
            path: path.to_path_buf(),
            message: format!("unsupported keypair version {}", record.version),
        });
    }
    let private_pem = normalize_pem(&record.private_key);
    let public_pem = normalize_pem(&record.public_key);
    let signing_key =
        SigningKey::from_pkcs8_pem(&private_pem).map_err(|error| PersistentJwtError::Decode {
            path: path.to_path_buf(),
            message: format!("invalid PKCS#8 private key: {error}"),
        })?;
    let verifying_key = VerifyingKey::from_public_key_pem(&public_pem).map_err(|error| {
        PersistentJwtError::Decode {
            path: path.to_path_buf(),
            message: format!("invalid SPKI public key: {error}"),
        }
    })?;
    if signing_key.verifying_key() != verifying_key {
        return Err(PersistentJwtError::Decode {
            path: path.to_path_buf(),
            message: "private and public keys do not form a pair".to_owned(),
        });
    }
    Ok(StoredKeyPair {
        private_pem,
        public_pem,
        signing_key,
    })
}

fn decode_public_key(value: &str) -> Result<VerifyingKey, PersistentJwtError> {
    let normalized = normalize_pem(value);
    if normalized.starts_with('{') {
        let jwk: PublicJwk = serde_json::from_str(&normalized)
            .map_err(|error| jwt(format!("invalid Ed25519 public JWK: {error}")))?;
        if jwk.kty != "OKP"
            || jwk.crv != "Ed25519"
            || jwk.alg.as_deref().is_some_and(|alg| alg != "EdDSA")
            || jwk
                .key_use
                .as_deref()
                .is_some_and(|key_use| key_use != "sig")
        {
            return Err(jwt("public JWK is not an Ed25519 signing key"));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(jwk.x)
            .map_err(|error| jwt(format!("invalid Ed25519 JWK x coordinate: {error}")))?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| jwt("Ed25519 JWK x coordinate must contain 32 bytes"))?;
        VerifyingKey::from_bytes(&bytes)
            .map_err(|error| jwt(format!("invalid Ed25519 public key: {error}")))
    } else {
        VerifyingKey::from_public_key_pem(&normalized)
            .map_err(|error| jwt(format!("invalid Ed25519 SPKI public key: {error}")))
    }
}

fn validate_typ(typ: &str) -> Result<(), PersistentJwtError> {
    if typ.is_empty() || typ.len() > 128 || typ.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(jwt("JWT typ is invalid"));
    }
    Ok(())
}

fn validate_registered_claims(claims: &RegisteredClaims) -> Result<(), PersistentJwtError> {
    if [
        claims.iss.as_str(),
        claims.sub.as_str(),
        claims.aud.as_str(),
        claims.jti.as_str(),
    ]
    .iter()
    .any(|value| value.trim().is_empty())
        || claims.exp <= claims.iat
    {
        return Err(jwt("JWT registered claims are invalid"));
    }
    Ok(())
}

fn validate_cloud_claims(
    claims: &CloudProofClaims,
    issuer: &str,
    audience: &str,
    now: i64,
) -> Result<(), PersistentJwtError> {
    let registered = RegisteredClaims {
        iss: claims.iss.clone(),
        sub: claims.sub.clone(),
        aud: claims.aud.clone(),
        jti: claims.jti.clone(),
        iat: claims.iat,
        exp: claims.exp,
    };
    validate_registered_claims(&registered)?;
    if claims.iss != issuer
        || claims.aud != audience
        || claims.environment_id.trim().is_empty()
        || claims.nonce.trim().is_empty()
        || claims.scope.is_empty()
        || claims.scope.iter().any(|scope| scope.trim().is_empty())
        || claims.iat > now.saturating_add(CLOCK_SKEW_SECONDS)
        || claims.iat < now.saturating_sub(MAX_TOKEN_AGE_SECONDS + CLOCK_SKEW_SECONDS)
        || claims.exp < now.saturating_sub(CLOCK_SKEW_SECONDS)
    {
        return Err(jwt(
            "JWT claims failed issuer, audience, or time validation",
        ));
    }
    Ok(())
}

fn decode_json_segment<T: for<'de> Deserialize<'de>>(
    encoded: &str,
    name: &str,
) -> Result<T, PersistentJwtError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|error| jwt(format!("invalid JWT {name} encoding: {error}")))?;
    serde_json::from_slice(&bytes).map_err(|error| jwt(format!("invalid JWT {name} JSON: {error}")))
}

fn normalize_pem(value: &str) -> String {
    value.replace("\\n", "\n").trim().to_owned()
}

fn jwt(message: impl Into<String>) -> PersistentJwtError {
    PersistentJwtError::Jwt(message.into())
}

fn jwt_error(error: impl std::fmt::Display) -> PersistentJwtError {
    jwt(error.to_string())
}

#[cfg(unix)]
async fn secure_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await
}

#[cfg(unix)]
async fn secure_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
}

#[cfg(windows)]
async fn secure_directory(path: &Path) -> io::Result<()> {
    secure_windows_path(path, true).await
}

#[cfg(windows)]
async fn secure_file(path: &Path) -> io::Result<()> {
    secure_windows_path(path, false).await
}

#[cfg(windows)]
async fn secure_windows_path(path: &Path, inheritable: bool) -> io::Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || set_restrictive_windows_acl(&path, inheritable))
        .await
        .map_err(io::Error::other)?
}

#[cfg(windows)]
fn set_restrictive_windows_acl(path: &Path, inheritable: bool) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt as _, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, LocalFree},
        Security::{
            Authorization::{
                EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SET_ACCESS,
                SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
                TRUSTEE_W,
            },
            DACL_SECURITY_INFORMATION, GetTokenInformation, PROTECTED_DACL_SECURITY_INFORMATION,
            SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `token` is a valid out pointer and the pseudo process handle is valid.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut required_bytes = 0_u32;
        // SAFETY: This sizing call intentionally supplies no destination buffer.
        unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut required_bytes) };
        if required_bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let word_bytes = std::mem::size_of::<usize>();
        let word_count = usize::try_from(required_bytes)
            .ok()
            .and_then(|bytes| bytes.checked_add(word_bytes - 1))
            .map(|bytes| bytes / word_bytes)
            .ok_or_else(|| io::Error::other("Windows token information is too large"))?;
        let mut token_buffer = vec![0_usize; word_count];
        // SAFETY: The aligned buffer has at least `required_bytes` writable bytes.
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                token_buffer.as_mut_ptr().cast::<c_void>(),
                required_bytes,
                &mut required_bytes,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: A successful TokenUser query initializes a TOKEN_USER at the buffer start.
        let user_sid = unsafe { (*(token_buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: if inheritable {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                0
            },
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: user_sid.cast(),
            },
        };
        let mut acl = ptr::null_mut();
        // SAFETY: The entry and output ACL pointers are valid for the duration of the call.
        let acl_status = unsafe { SetEntriesInAclW(1, &entry, ptr::null(), &mut acl) };
        if acl_status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(acl_status.cast_signed()));
        }
        let wide_path = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: The path is NUL-terminated and `acl` is owned until LocalFree below.
        let set_status = unsafe {
            SetNamedSecurityInfoW(
                wide_path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null(),
            )
        };
        // SAFETY: SetEntriesInAclW allocated `acl` with LocalAlloc on success.
        unsafe { LocalFree(acl.cast()) };
        if set_status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(set_status.cast_signed()))
        }
    })();
    // SAFETY: OpenProcessToken returned an owned real handle.
    unsafe { CloseHandle(token) };
    result
}
