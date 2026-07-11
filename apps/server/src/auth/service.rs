use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use subtle::ConstantTimeEq;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

use super::{
    dpop::DpopVerifier,
    model::{
        ADMINISTRATIVE_SCOPES, ALL_SCOPES, AuthAccessChange, AuthAccessEvent, AuthDescriptor,
        ClientMetadata, ClientSessionView, PairingCredentialResult, PairingLinkView, Principal,
        STANDARD_SCOPES,
    },
    secret_store::SecretStore,
    token::{SessionClaims, TokenError, TokenSigner, WebSocketClaims},
};
use crate::config::{ServerConfig, ServerMode};
use crate::persistence::{
    AuthPairingLink as PersistedPairingLink, AuthSession as PersistedAuthSession,
    AuthSessionClient as PersistedAuthSessionClient, NewAuthSession, Repositories,
};

const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const DPOP_SESSION_TTL_MS: i64 = 60 * 60 * 1_000;
const WEBSOCKET_TICKET_TTL_MS: i64 = 5 * 60 * 1_000;
const PAIRING_TTL_MS: i64 = 5 * 60 * 1_000;
const CLOUD_PAIRING_TTL_MS: i64 = 2 * 60 * 1_000;
const DESKTOP_BOOTSTRAP_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const PAIRING_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_LENGTH: usize = 12;
const PAIRING_REJECTION_LIMIT: u8 =
    (u8::MAX as usize / PAIRING_ALPHABET.len() * PAIRING_ALPHABET.len()) as u8;
const ACCESS_EVENT_CAPACITY: usize = 64;
const MAX_ACTIVE_PAIRINGS: usize = 4_096;
const MAX_ACTIVE_SESSIONS: usize = 4_096;

#[derive(Clone, Debug)]
pub enum AuthError {
    MissingCredential,
    InvalidCredential,
    InvalidScope,
    ScopeNotGranted,
    ScopeRequired(String),
    CurrentSessionRevokeNotAllowed,
    Internal(String),
}

#[derive(Clone)]
pub struct AuthService {
    descriptor: AuthDescriptor,
    desktop_bootstrap: Option<DesktopBootstrap>,
    signer: TokenSigner,
    state: Arc<Mutex<AuthState>>,
    issuance: Arc<Mutex<()>>,
    repositories: Option<Repositories>,
    access_events: broadcast::Sender<AuthAccessEvent>,
    access_revision: Arc<AtomicU64>,
    dpop: DpopVerifier,
}

#[derive(Clone)]
struct DesktopBootstrap {
    credential: String,
    expires_at_ms: i64,
}

#[derive(Default)]
struct AuthState {
    sessions: HashMap<String, SessionRecord>,
    pairings: HashMap<String, PairingRecord>,
}

#[derive(Clone)]
struct SessionRecord {
    session_id: String,
    subject: String,
    scopes: Vec<String>,
    method: String,
    client: ClientMetadata,
    issued_at_ms: i64,
    expires_at_ms: i64,
    revoked_at_ms: Option<i64>,
    last_connected_at_ms: Option<i64>,
    connected_count: usize,
    proof_key_thumbprint: Option<String>,
}

#[derive(Clone)]
struct PairingRecord {
    id: String,
    credential: String,
    scopes: Vec<String>,
    subject: String,
    label: Option<String>,
    proof_key_thumbprint: Option<String>,
    created_at_ms: i64,
    expires_at_ms: i64,
    consumed_at_ms: Option<i64>,
    revoked_at_ms: Option<i64>,
}

struct Grant {
    scopes: Vec<String>,
    subject: String,
    label: Option<String>,
}

pub struct IssuedSession {
    pub token: String,
    pub principal: Principal,
}

impl AuthService {
    #[must_use]
    #[cfg(test)]
    pub fn new(config: &ServerConfig, signing_secret: Vec<u8>) -> Self {
        Self::build(config, signing_secret, None, None)
    }

    pub(crate) async fn new_with_persistence(
        config: &ServerConfig,
        signing_secret: Vec<u8>,
        secret_store: SecretStore,
        repositories: Repositories,
    ) -> Result<Self, AuthError> {
        let service = Self::build(
            config,
            signing_secret,
            Some(secret_store),
            Some(repositories),
        );
        service.hydrate_active_state().await?;
        Ok(service)
    }

    fn build(
        config: &ServerConfig,
        signing_secret: Vec<u8>,
        secret_store: Option<SecretStore>,
        repositories: Option<Repositories>,
    ) -> Self {
        let remote_reachable = !is_loopback_host(&config.host);
        let policy = match (config.unsafe_no_auth, config.mode, remote_reachable) {
            (true, _, _) => "unsafe-no-auth",
            (false, ServerMode::Desktop, false) => "desktop-managed-local",
            (false, ServerMode::Web, false) => "loopback-browser",
            (false, _, true) => "remote-reachable",
        };
        let bootstrap_methods = match (config.unsafe_no_auth, config.mode, policy) {
            (true, _, _) => Vec::new(),
            (false, ServerMode::Desktop, "desktop-managed-local") => vec!["desktop-bootstrap"],
            (false, ServerMode::Desktop, _) => vec!["desktop-bootstrap", "one-time-token"],
            (false, _, _) => vec!["one-time-token"],
        };
        let session_cookie_name = if config.mode == ServerMode::Desktop {
            format!("t4code_session_{}", config.port)
        } else {
            "t4code_session".to_owned()
        };
        let desktop_bootstrap =
            config
                .desktop_bootstrap_token
                .as_ref()
                .map(|credential| DesktopBootstrap {
                    credential: credential.clone(),
                    expires_at_ms: now_ms().saturating_add(DESKTOP_BOOTSTRAP_TTL_MS),
                });
        let (access_events, _) = broadcast::channel(ACCESS_EVENT_CAPACITY);
        Self {
            descriptor: AuthDescriptor {
                policy,
                bootstrap_methods,
                session_methods: [
                    "browser-session-cookie",
                    "bearer-access-token",
                    "dpop-access-token",
                ],
                session_cookie_name,
            },
            desktop_bootstrap,
            signer: TokenSigner::new(signing_secret),
            state: Arc::new(Mutex::new(AuthState::default())),
            issuance: Arc::new(Mutex::new(())),
            repositories,
            access_events,
            access_revision: Arc::new(AtomicU64::new(1)),
            dpop: DpopVerifier::new(secret_store),
        }
    }

    async fn hydrate_active_state(&self) -> Result<(), AuthError> {
        let Some(repositories) = &self.repositories else {
            return Ok(());
        };
        let now = format_iso(now_ms());
        let pairings = repositories
            .list_active_auth_pairing_links(now.clone())
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let sessions = repositories
            .list_active_auth_sessions(now)
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let pairings = pairings
            .into_iter()
            .map(pairing_record_from_persisted)
            .collect::<Result<Vec<_>, _>>()?;
        let sessions = sessions
            .into_iter()
            .map(session_record_from_persisted)
            .collect::<Result<Vec<_>, _>>()?;
        let mut state = self.state.lock().await;
        state.pairings = pairings
            .into_iter()
            .map(|pairing| (pairing.id.clone(), pairing))
            .collect();
        state.sessions = sessions
            .into_iter()
            .map(|session| (session.session_id.clone(), session))
            .collect();
        Ok(())
    }

    #[must_use]
    pub fn descriptor(&self) -> AuthDescriptor {
        self.descriptor.clone()
    }

    #[must_use]
    pub fn cookie_name(&self) -> &str {
        &self.descriptor.session_cookie_name
    }

    #[must_use]
    pub(crate) fn subscribe_access(&self) -> broadcast::Receiver<AuthAccessEvent> {
        self.access_events.subscribe()
    }

    pub(crate) async fn access_snapshot(
        &self,
        current_session_id: &str,
    ) -> (u64, Vec<PairingLinkView>, Vec<ClientSessionView>) {
        let now = now_ms();
        let state = self.state.lock().await;
        let mut pairings = state
            .pairings
            .values()
            .filter(|pairing| {
                pairing.consumed_at_ms.is_none()
                    && pairing.revoked_at_ms.is_none()
                    && pairing.expires_at_ms > now
            })
            .map(PairingRecord::view)
            .collect::<Vec<_>>();
        pairings.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        let mut sessions = state
            .sessions
            .values()
            .filter(|session| session.revoked_at_ms.is_none() && session.expires_at_ms > now)
            .map(|session| session.view(session.session_id == current_session_id))
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| !session.current);
        let revision = self.access_revision.load(Ordering::Acquire);
        (revision, pairings, sessions)
    }

    fn emit_access_change(&self, change: AuthAccessChange) {
        let revision = self.access_revision.fetch_add(1, Ordering::AcqRel) + 1;
        let _ = self
            .access_events
            .send(AuthAccessEvent { revision, change });
    }

    pub async fn create_browser_session(
        &self,
        credential: &str,
        client: ClientMetadata,
    ) -> Result<IssuedSession, AuthError> {
        let grant = self.consume_grant(credential, None).await?;
        self.issue_session(
            grant.subject,
            grant.scopes,
            "browser-session-cookie",
            apply_grant_label(client, grant.label),
            None,
        )
        .await
    }

    pub async fn exchange_bootstrap(
        &self,
        credential: &str,
        requested_scopes: Option<Vec<String>>,
        client: ClientMetadata,
        proof_key_thumbprint: Option<String>,
    ) -> Result<IssuedSession, AuthError> {
        let grant = self
            .consume_grant(credential, proof_key_thumbprint.as_deref())
            .await?;
        let scopes = requested_scopes.unwrap_or_else(|| grant.scopes.clone());
        if !scopes
            .iter()
            .all(|scope| grant.scopes.iter().any(|granted| granted == scope))
        {
            return Err(AuthError::ScopeNotGranted);
        }
        let method = if proof_key_thumbprint.is_some() {
            "dpop-access-token"
        } else {
            "bearer-access-token"
        };
        self.issue_session(
            grant.subject,
            scopes,
            method,
            apply_grant_label(client, grant.label),
            proof_key_thumbprint,
        )
        .await
    }

    pub async fn authenticate_token(&self, token: &str) -> Result<Principal, AuthError> {
        let claims: SessionClaims = self
            .signer
            .verify(token)
            .map_err(map_token_error_to_credential)?;
        let observed_at = now_ms();
        if claims.v != 1
            || claims.kind != "session"
            || claims.exp <= observed_at
            || claims.scopes.iter().any(|scope| !is_scope(scope))
        {
            return Err(AuthError::InvalidCredential);
        }
        self.refresh_session_from_repository(&claims.sid, observed_at)
            .await?;
        let state = self.state.lock().await;
        let record = state
            .sessions
            .get(&claims.sid)
            .ok_or(AuthError::InvalidCredential)?;
        if record.revoked_at_ms.is_some()
            || record.expires_at_ms <= observed_at
            || record.expires_at_ms != claims.exp
            || record.subject != claims.sub
            || record.method != claims.method
            || record.scopes != claims.scopes
        {
            return Err(AuthError::InvalidCredential);
        }
        Ok(Principal {
            session_id: claims.sid,
            subject: claims.sub,
            method: claims.method,
            scopes: claims.scopes,
            proof_key_thumbprint: claims.jkt,
            expires_at_ms: claims.exp,
        })
    }

    pub async fn verify_dpop(
        &self,
        proof: &str,
        method: &str,
        url: &str,
        expected_thumbprint: Option<&str>,
        expected_access_token: Option<&str>,
    ) -> Result<String, AuthError> {
        self.dpop
            .verify(
                proof,
                method,
                url,
                now_ms() / 1_000,
                expected_thumbprint,
                expected_access_token,
            )
            .await
    }

    pub fn issue_websocket_ticket(
        &self,
        principal: &Principal,
    ) -> Result<(String, i64), AuthError> {
        let issued_at = now_ms();
        let expires_at = issued_at.saturating_add(WEBSOCKET_TICKET_TTL_MS);
        let claims = WebSocketClaims {
            v: 1,
            kind: "websocket".to_owned(),
            sid: principal.session_id.clone(),
            iat: issued_at,
            exp: expires_at,
        };
        self.signer
            .issue(&claims)
            .map(|token| (token, expires_at))
            .map_err(|error| AuthError::Internal(error.to_string()))
    }

    pub async fn verify_websocket_ticket(&self, token: &str) -> Result<Principal, AuthError> {
        let claims: WebSocketClaims = self
            .signer
            .verify(token)
            .map_err(map_token_error_to_credential)?;
        let observed_at = now_ms();
        if claims.v != 1 || claims.kind != "websocket" || claims.exp <= observed_at {
            return Err(AuthError::InvalidCredential);
        }
        self.refresh_session_from_repository(&claims.sid, observed_at)
            .await?;
        let state = self.state.lock().await;
        let record = state
            .sessions
            .get(&claims.sid)
            .ok_or(AuthError::InvalidCredential)?;
        if record.revoked_at_ms.is_some() || record.expires_at_ms <= observed_at {
            return Err(AuthError::InvalidCredential);
        }
        Ok(record.principal())
    }

    pub(crate) async fn authorize_session(
        &self,
        session_id: &str,
        required_scope: &str,
    ) -> Result<(), AuthError> {
        let observed_at = now_ms();
        self.refresh_session_from_repository(session_id, observed_at)
            .await?;
        let state = self.state.lock().await;
        let session = state
            .sessions
            .get(session_id)
            .ok_or(AuthError::InvalidCredential)?;
        if session.revoked_at_ms.is_some() || session.expires_at_ms <= observed_at {
            return Err(AuthError::InvalidCredential);
        }
        if session.scopes.iter().any(|scope| scope == required_scope) {
            Ok(())
        } else {
            Err(AuthError::ScopeRequired(required_scope.to_owned()))
        }
    }

    async fn refresh_session_from_repository(
        &self,
        session_id: &str,
        observed_at: i64,
    ) -> Result<(), AuthError> {
        let Some(repositories) = &self.repositories else {
            return Ok(());
        };
        let persisted = repositories
            .get_auth_session(session_id.to_owned())
            .await
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let Some(persisted) = persisted else {
            self.state.lock().await.sessions.remove(session_id);
            return Err(AuthError::InvalidCredential);
        };
        if persisted.revoked_at.is_some()
            || parse_timestamp_ms(&persisted.expires_at)? <= observed_at
        {
            self.state.lock().await.sessions.remove(session_id);
            return Err(AuthError::InvalidCredential);
        }
        let mut refreshed = session_record_from_persisted(persisted)?;
        let mut state = self.state.lock().await;
        if let Some(current) = state.sessions.get(session_id) {
            refreshed.connected_count = current.connected_count;
            refreshed.proof_key_thumbprint = current.proof_key_thumbprint.clone();
        }
        state.sessions.insert(session_id.to_owned(), refreshed);
        Ok(())
    }

    pub async fn issue_pairing(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
    ) -> Result<PairingCredentialResult, AuthError> {
        self.issue_pairing_for_subject(scopes, label, "one-time-token", None, PAIRING_TTL_MS)
            .await
    }

    pub async fn issue_pairing_with_proof(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
        proof_key_thumbprint: String,
    ) -> Result<PairingCredentialResult, AuthError> {
        if proof_key_thumbprint.trim().is_empty() {
            return Err(AuthError::InvalidCredential);
        }
        self.issue_pairing_for_subject(
            scopes,
            label,
            "one-time-token",
            Some(proof_key_thumbprint),
            PAIRING_TTL_MS,
        )
        .await
    }

    pub async fn issue_cloud_pairing(
        &self,
        proof_key_thumbprint: String,
    ) -> Result<PairingCredentialResult, AuthError> {
        if proof_key_thumbprint.trim().is_empty() {
            return Err(AuthError::InvalidCredential);
        }
        self.issue_pairing_for_subject(
            owned_scopes(STANDARD_SCOPES),
            Some("T4 Connect connect".to_owned()),
            "cloud-connect",
            Some(proof_key_thumbprint),
            CLOUD_PAIRING_TTL_MS,
        )
        .await
    }

    pub(crate) async fn issue_startup_pairing(&self) -> Result<PairingCredentialResult, AuthError> {
        self.issue_pairing_for_subject(
            owned_scopes(ADMINISTRATIVE_SCOPES),
            None,
            "administrative-bootstrap",
            None,
            PAIRING_TTL_MS,
        )
        .await
    }

    async fn issue_pairing_for_subject(
        &self,
        scopes: Vec<String>,
        label: Option<String>,
        subject: &str,
        proof_key_thumbprint: Option<String>,
        ttl_ms: i64,
    ) -> Result<PairingCredentialResult, AuthError> {
        let _issuance = self.issuance.lock().await;
        if scopes.is_empty()
            || scopes.iter().any(|scope| !is_scope(scope))
            || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
        {
            return Err(AuthError::InvalidScope);
        }
        let now = now_ms();
        let expires_at = now.saturating_add(ttl_ms);
        let credential = {
            let mut state = self.state.lock().await;
            state.pairings.retain(|_, pairing| {
                pairing.consumed_at_ms.is_none()
                    && pairing.revoked_at_ms.is_none()
                    && pairing.expires_at_ms > now
            });
            if state.pairings.len() >= MAX_ACTIVE_PAIRINGS {
                return Err(AuthError::Internal(
                    "active pairing capacity exceeded".to_owned(),
                ));
            }
            loop {
                let candidate = generate_pairing_credential()?;
                if !state
                    .pairings
                    .values()
                    .any(|pairing| pairing.credential == candidate)
                {
                    break candidate;
                }
            }
        };
        let id = Uuid::new_v4().to_string();
        let record = PairingRecord {
            id: id.clone(),
            credential: credential.clone(),
            scopes,
            subject: subject.to_owned(),
            label: label.clone(),
            proof_key_thumbprint,
            created_at_ms: now,
            expires_at_ms: expires_at,
            consumed_at_ms: None,
            revoked_at_ms: None,
        };
        let view = record.view();
        if let Some(repositories) = &self.repositories {
            repositories
                .create_auth_pairing_link(persisted_pairing_link(&record))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
        }
        self.state.lock().await.pairings.insert(id.clone(), record);
        self.emit_access_change(AuthAccessChange::PairingLinkUpserted(view));
        Ok(PairingCredentialResult {
            id,
            credential,
            label,
            expires_at: format_iso(expires_at),
        })
    }

    pub async fn list_pairings(&self) -> Vec<PairingLinkView> {
        let now = now_ms();
        let mut state = self.state.lock().await;
        state.pairings.retain(|_, pairing| {
            pairing.consumed_at_ms.is_none()
                && pairing.revoked_at_ms.is_none()
                && pairing.expires_at_ms > now
        });
        let mut pairings = state
            .pairings
            .values()
            .filter(|pairing| {
                pairing.consumed_at_ms.is_none()
                    && pairing.revoked_at_ms.is_none()
                    && pairing.expires_at_ms > now
            })
            .map(PairingRecord::view)
            .collect::<Vec<_>>();
        pairings.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        pairings
    }

    pub async fn revoke_pairing(&self, id: &str) -> Result<bool, AuthError> {
        let revoked_at = now_ms();
        if let Some(repositories) = &self.repositories {
            let revoked = repositories
                .revoke_auth_pairing_link(id.to_owned(), format_iso(revoked_at))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            if !revoked {
                return Ok(false);
            }
            self.state.lock().await.pairings.remove(id);
            self.emit_access_change(AuthAccessChange::PairingLinkRemoved { id: id.to_owned() });
            return Ok(true);
        }
        let mut state = self.state.lock().await;
        let Some(pairing) = state.pairings.get_mut(id) else {
            return Ok(false);
        };
        if pairing.revoked_at_ms.is_some() {
            return Ok(false);
        }
        pairing.revoked_at_ms = Some(revoked_at);
        let id = pairing.id.clone();
        state.pairings.remove(&id);
        drop(state);
        self.emit_access_change(AuthAccessChange::PairingLinkRemoved { id });
        Ok(true)
    }

    pub async fn list_clients(&self, current_session_id: &str) -> Vec<ClientSessionView> {
        let now = now_ms();
        let mut state = self.state.lock().await;
        state
            .sessions
            .retain(|_, session| session.revoked_at_ms.is_none() && session.expires_at_ms > now);
        let mut sessions = state
            .sessions
            .values()
            .filter(|session| session.revoked_at_ms.is_none() && session.expires_at_ms > now)
            .map(|session| session.view(session.session_id == current_session_id))
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| !session.current);
        sessions
    }

    pub async fn revoke_client(
        &self,
        current_session_id: &str,
        target_session_id: &str,
    ) -> Result<bool, AuthError> {
        if current_session_id == target_session_id {
            return Err(AuthError::CurrentSessionRevokeNotAllowed);
        }
        let revoked_at = now_ms();
        if let Some(repositories) = &self.repositories {
            let revoked = repositories
                .revoke_auth_session(target_session_id.to_owned(), format_iso(revoked_at))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            if revoked {
                self.state.lock().await.sessions.remove(target_session_id);
                self.emit_access_change(AuthAccessChange::ClientRemoved {
                    session_id: target_session_id.to_owned(),
                });
            }
            return Ok(revoked);
        }
        let mut state = self.state.lock().await;
        let Some(session) = state.sessions.get_mut(target_session_id) else {
            return Ok(false);
        };
        if session.revoked_at_ms.is_some() {
            return Ok(false);
        }
        session.revoked_at_ms = Some(revoked_at);
        let session_id = session.session_id.clone();
        state.sessions.remove(&session_id);
        drop(state);
        self.emit_access_change(AuthAccessChange::ClientRemoved { session_id });
        Ok(true)
    }

    pub async fn revoke_other_clients(&self, current_session_id: &str) -> Result<usize, AuthError> {
        let now = now_ms();
        if let Some(repositories) = &self.repositories {
            let removed_session_ids = repositories
                .revoke_other_auth_sessions(current_session_id.to_owned(), format_iso(now))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
            let mut state = self.state.lock().await;
            for session_id in &removed_session_ids {
                state.sessions.remove(session_id);
            }
            drop(state);
            for session_id in &removed_session_ids {
                self.emit_access_change(AuthAccessChange::ClientRemoved {
                    session_id: session_id.clone(),
                });
            }
            return Ok(removed_session_ids.len());
        }
        let mut state = self.state.lock().await;
        let mut revoked = 0;
        let mut removed_session_ids = Vec::new();
        for session in state.sessions.values_mut() {
            if session.session_id != current_session_id && session.revoked_at_ms.is_none() {
                session.revoked_at_ms = Some(now);
                removed_session_ids.push(session.session_id.clone());
                revoked += 1;
            }
        }
        drop(state);
        for session_id in removed_session_ids {
            self.emit_access_change(AuthAccessChange::ClientRemoved { session_id });
        }
        Ok(revoked)
    }

    pub async fn mark_connected(&self, session_id: &str) {
        let mut state = self.state.lock().await;
        let view = if let Some(session) = state.sessions.get_mut(session_id) {
            if session.connected_count == 0 {
                session.last_connected_at_ms = Some(now_ms());
            }
            session.connected_count = session.connected_count.saturating_add(1);
            Some(session.view(false))
        } else {
            None
        };
        drop(state);
        if let Some(view) = view {
            if let Some(repositories) = &self.repositories
                && let Err(error) = repositories
                    .set_auth_session_last_connected_at(
                        session_id.to_owned(),
                        view.last_connected_at
                            .clone()
                            .unwrap_or_else(|| format_iso(now_ms())),
                    )
                    .await
            {
                tracing::error!(%error, %session_id, "failed to persist session connection time");
            }
            self.emit_access_change(AuthAccessChange::ClientUpserted(view));
        }
    }

    pub async fn mark_disconnected(&self, session_id: &str) {
        let mut state = self.state.lock().await;
        let view = if let Some(session) = state.sessions.get_mut(session_id) {
            session.connected_count = session.connected_count.saturating_sub(1);
            Some(session.view(false))
        } else {
            None
        };
        drop(state);
        if let Some(view) = view {
            self.emit_access_change(AuthAccessChange::ClientUpserted(view));
        }
    }

    async fn issue_session(
        &self,
        subject: String,
        scopes: Vec<String>,
        method: &str,
        client: ClientMetadata,
        proof_key_thumbprint: Option<String>,
    ) -> Result<IssuedSession, AuthError> {
        let _issuance = self.issuance.lock().await;
        let issued_at = now_ms();
        let ttl = if proof_key_thumbprint.is_some() {
            DPOP_SESSION_TTL_MS
        } else {
            SESSION_TTL_MS
        };
        let expires_at = issued_at.saturating_add(ttl);
        let session_id = Uuid::new_v4().to_string();
        let claims = SessionClaims {
            v: 1,
            kind: "session".to_owned(),
            sid: session_id.clone(),
            sub: subject.clone(),
            scopes: scopes.clone(),
            method: method.to_owned(),
            jkt: proof_key_thumbprint.clone(),
            iat: issued_at,
            exp: expires_at,
        };
        let token = self
            .signer
            .issue(&claims)
            .map_err(|error| AuthError::Internal(error.to_string()))?;
        let record = SessionRecord {
            session_id: session_id.clone(),
            subject: subject.clone(),
            scopes: scopes.clone(),
            method: method.to_owned(),
            client,
            issued_at_ms: issued_at,
            expires_at_ms: expires_at,
            revoked_at_ms: None,
            last_connected_at_ms: None,
            connected_count: 0,
            proof_key_thumbprint: proof_key_thumbprint.clone(),
        };
        {
            let mut state = self.state.lock().await;
            state.sessions.retain(|_, session| {
                session.revoked_at_ms.is_none() && session.expires_at_ms > issued_at
            });
            if state.sessions.len() >= MAX_ACTIVE_SESSIONS {
                return Err(AuthError::Internal(
                    "active session capacity exceeded".to_owned(),
                ));
            }
        }
        let view = record.view(false);
        if let Some(repositories) = &self.repositories {
            repositories
                .create_auth_session(persisted_auth_session(&record))
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?;
        }
        self.state
            .lock()
            .await
            .sessions
            .insert(session_id.clone(), record);
        self.emit_access_change(AuthAccessChange::ClientUpserted(view));
        Ok(IssuedSession {
            token,
            principal: Principal {
                session_id,
                subject,
                method: method.to_owned(),
                scopes,
                proof_key_thumbprint,
                expires_at_ms: expires_at,
            },
        })
    }

    async fn consume_grant(
        &self,
        credential: &str,
        proof_key_thumbprint: Option<&str>,
    ) -> Result<Grant, AuthError> {
        let now = now_ms();
        if let Some(desktop) = &self.desktop_bootstrap
            && constant_time_text_equal(&desktop.credential, credential)
        {
            return if desktop.expires_at_ms > now {
                Ok(Grant {
                    scopes: owned_scopes(ADMINISTRATIVE_SCOPES),
                    subject: "desktop-bootstrap".to_owned(),
                    label: None,
                })
            } else {
                Err(AuthError::InvalidCredential)
            };
        }

        if let Some(repositories) = &self.repositories {
            let consumed = repositories
                .consume_auth_pairing_link(
                    credential.to_owned(),
                    proof_key_thumbprint.map(str::to_owned),
                    format_iso(now),
                    format_iso(now),
                )
                .await
                .map_err(|error| AuthError::Internal(error.to_string()))?
                .ok_or(AuthError::InvalidCredential)?;
            let pairing = pairing_record_from_persisted(consumed)?;
            self.state.lock().await.pairings.remove(&pairing.id);
            self.emit_access_change(AuthAccessChange::PairingLinkRemoved {
                id: pairing.id.clone(),
            });
            return Ok(Grant {
                scopes: pairing.scopes,
                subject: pairing.subject,
                label: pairing.label,
            });
        }

        let mut state = self.state.lock().await;
        let pairing = state
            .pairings
            .values_mut()
            .find(|pairing| pairing.credential == credential)
            .ok_or(AuthError::InvalidCredential)?;
        if pairing.revoked_at_ms.is_some()
            || pairing.consumed_at_ms.is_some()
            || pairing.expires_at_ms <= now
            || pairing
                .proof_key_thumbprint
                .as_deref()
                .is_some_and(|expected| Some(expected) != proof_key_thumbprint)
        {
            return Err(AuthError::InvalidCredential);
        }
        pairing.consumed_at_ms = Some(now);
        let pairing_id = pairing.id.clone();
        let grant = Grant {
            scopes: pairing.scopes.clone(),
            subject: pairing.subject.clone(),
            label: pairing.label.clone(),
        };
        drop(state);
        self.emit_access_change(AuthAccessChange::PairingLinkRemoved { id: pairing_id });
        Ok(grant)
    }
}

impl SessionRecord {
    fn principal(&self) -> Principal {
        Principal {
            session_id: self.session_id.clone(),
            subject: self.subject.clone(),
            method: self.method.clone(),
            scopes: self.scopes.clone(),
            proof_key_thumbprint: self.proof_key_thumbprint.clone(),
            expires_at_ms: self.expires_at_ms,
        }
    }

    fn view(&self, current: bool) -> ClientSessionView {
        ClientSessionView {
            session_id: self.session_id.clone(),
            subject: self.subject.clone(),
            scopes: self.scopes.clone(),
            method: self.method.clone(),
            client: self.client.clone(),
            issued_at: format_iso(self.issued_at_ms),
            expires_at: format_iso(self.expires_at_ms),
            last_connected_at: self.last_connected_at_ms.map(format_iso),
            connected: self.connected_count > 0,
            current,
        }
    }
}

impl PairingRecord {
    fn view(&self) -> PairingLinkView {
        PairingLinkView {
            id: self.id.clone(),
            credential: self.credential.clone(),
            scopes: self.scopes.clone(),
            subject: self.subject.clone(),
            label: self.label.clone(),
            created_at: format_iso(self.created_at_ms),
            expires_at: format_iso(self.expires_at_ms),
        }
    }
}

fn persisted_pairing_link(record: &PairingRecord) -> PersistedPairingLink {
    PersistedPairingLink {
        id: record.id.clone(),
        credential: record.credential.clone(),
        method: "one-time-token".to_owned(),
        scopes: serde_json::json!(record.scopes),
        subject: record.subject.clone(),
        label: record.label.clone(),
        proof_key_thumbprint: record.proof_key_thumbprint.clone(),
        created_at: format_iso(record.created_at_ms),
        expires_at: format_iso(record.expires_at_ms),
        consumed_at: record.consumed_at_ms.map(format_iso),
        revoked_at: record.revoked_at_ms.map(format_iso),
    }
}

fn persisted_auth_session(record: &SessionRecord) -> NewAuthSession {
    NewAuthSession {
        session_id: record.session_id.clone(),
        subject: record.subject.clone(),
        scopes: serde_json::json!(record.scopes),
        method: record.method.clone(),
        client: PersistedAuthSessionClient {
            label: record.client.label.clone(),
            ip_address: record.client.ip_address.clone(),
            user_agent: record.client.user_agent.clone(),
            device_type: record.client.device_type.clone(),
            os: record.client.os.clone(),
            browser: record.client.browser.clone(),
        },
        issued_at: format_iso(record.issued_at_ms),
        expires_at: format_iso(record.expires_at_ms),
    }
}

fn pairing_record_from_persisted(row: PersistedPairingLink) -> Result<PairingRecord, AuthError> {
    let scopes = decode_persisted_scopes(row.scopes)?;
    Ok(PairingRecord {
        id: row.id,
        credential: row.credential,
        scopes,
        subject: row.subject,
        label: row.label,
        proof_key_thumbprint: row.proof_key_thumbprint,
        created_at_ms: parse_timestamp_ms(&row.created_at)?,
        expires_at_ms: parse_timestamp_ms(&row.expires_at)?,
        consumed_at_ms: row
            .consumed_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
        revoked_at_ms: row
            .revoked_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
    })
}

fn session_record_from_persisted(row: PersistedAuthSession) -> Result<SessionRecord, AuthError> {
    let scopes = decode_persisted_scopes(row.scopes)?;
    Ok(SessionRecord {
        session_id: row.session_id,
        subject: row.subject,
        scopes,
        method: row.method,
        client: ClientMetadata {
            label: row.client.label,
            ip_address: row.client.ip_address,
            user_agent: row.client.user_agent,
            device_type: row.client.device_type,
            os: row.client.os,
            browser: row.client.browser,
        },
        issued_at_ms: parse_timestamp_ms(&row.issued_at)?,
        expires_at_ms: parse_timestamp_ms(&row.expires_at)?,
        revoked_at_ms: row
            .revoked_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
        last_connected_at_ms: row
            .last_connected_at
            .as_deref()
            .map(parse_timestamp_ms)
            .transpose()?,
        connected_count: 0,
        proof_key_thumbprint: None,
    })
}

fn decode_persisted_scopes(value: serde_json::Value) -> Result<Vec<String>, AuthError> {
    let scopes = serde_json::from_value::<Vec<String>>(value)
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    if scopes.is_empty()
        || scopes.iter().any(|scope| !is_scope(scope))
        || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
    {
        return Err(AuthError::Internal(
            "persisted authentication scopes are invalid".to_owned(),
        ));
    }
    Ok(scopes)
}

fn parse_timestamp_ms(value: &str) -> Result<i64, AuthError> {
    let timestamp = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|error| AuthError::Internal(error.to_string()))?;
    i64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000)
        .map_err(|error| AuthError::Internal(error.to_string()))
}

pub fn parse_scopes(value: &str) -> Result<Vec<String>, AuthError> {
    let scopes = value
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if scopes.is_empty()
        || scopes.iter().any(|scope| !is_scope(scope))
        || scopes.iter().collect::<HashSet<_>>().len() != scopes.len()
    {
        return Err(AuthError::InvalidScope);
    }
    Ok(scopes)
}

#[must_use]
pub fn owned_scopes(scopes: &[&str]) -> Vec<String> {
    scopes.iter().map(|scope| (*scope).to_owned()).collect()
}

#[must_use]
pub fn format_iso(epoch_ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(epoch_ms) * 1_000_000)
        .ok()
        .and_then(|date| date.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}

#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn is_scope(scope: &str) -> bool {
    ALL_SCOPES.contains(&scope)
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    normalized == "localhost"
        || normalized
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn apply_grant_label(mut client: ClientMetadata, label: Option<String>) -> ClientMetadata {
    if label.is_some() {
        client.label = label;
    }
    client
}

fn map_token_error_to_credential(_error: TokenError) -> AuthError {
    AuthError::InvalidCredential
}

fn constant_time_text_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

fn generate_pairing_credential() -> Result<String, AuthError> {
    let mut credential = String::with_capacity(PAIRING_LENGTH);
    while credential.len() < PAIRING_LENGTH {
        let mut bytes = [0_u8; PAIRING_LENGTH];
        getrandom::fill(&mut bytes).map_err(|error| AuthError::Internal(error.to_string()))?;
        for byte in bytes {
            if byte >= PAIRING_REJECTION_LIMIT {
                continue;
            }
            credential.push(char::from(
                PAIRING_ALPHABET[usize::from(byte) % PAIRING_ALPHABET.len()],
            ));
            if credential.len() == PAIRING_LENGTH {
                break;
            }
        }
    }
    Ok(credential)
}

#[must_use]
pub fn default_standard_scopes() -> Vec<String> {
    owned_scopes(STANDARD_SCOPES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> AuthService {
        let config = ServerConfig::new(".")
            .with_bind("127.0.0.1", 3773)
            .with_desktop("desktop-test-seed")
            .expect("desktop config");
        AuthService::new(&config, vec![7_u8; 32])
    }

    #[tokio::test]
    async fn rejects_expired_session_claims_and_parent_sessions_for_websocket_tickets() {
        let service = service();
        let expired = SessionClaims {
            v: 1,
            kind: "session".to_owned(),
            sid: Uuid::new_v4().to_string(),
            sub: "expired".to_owned(),
            scopes: owned_scopes(STANDARD_SCOPES),
            method: "bearer-access-token".to_owned(),
            jkt: None,
            iat: now_ms() - 2_000,
            exp: now_ms() - 1_000,
        };
        let token = service.signer.issue(&expired).expect("expired token");
        assert!(matches!(
            service.authenticate_token(&token).await,
            Err(AuthError::InvalidCredential)
        ));

        let issued = service
            .exchange_bootstrap("desktop-test-seed", None, ClientMetadata::default(), None)
            .await
            .expect("session");
        let (ticket, _) = service
            .issue_websocket_ticket(&issued.principal)
            .expect("ticket");
        service
            .state
            .lock()
            .await
            .sessions
            .get_mut(&issued.principal.session_id)
            .expect("session row")
            .expires_at_ms = now_ms() - 1;
        assert!(matches!(
            service.verify_websocket_ticket(&ticket).await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[tokio::test]
    async fn consumes_pairing_credentials_atomically_under_race() {
        let service = service();
        let pairing = service
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("pairing");
        let first =
            service.exchange_bootstrap(&pairing.credential, None, ClientMetadata::default(), None);
        let second =
            service.exchange_bootstrap(&pairing.credential, None, ClientMetadata::default(), None);
        let (first, second) = tokio::join!(first, second);
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    }

    #[tokio::test]
    async fn rejects_expired_pairing_credentials_without_consuming_them() {
        let service = service();
        let pairing = service
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("pairing");
        service
            .state
            .lock()
            .await
            .pairings
            .get_mut(&pairing.id)
            .expect("pairing row")
            .expires_at_ms = now_ms() - 1;

        assert!(matches!(
            service
                .exchange_bootstrap(&pairing.credential, None, ClientMetadata::default(), None)
                .await,
            Err(AuthError::InvalidCredential)
        ));
    }

    #[test]
    fn parses_only_unique_known_non_empty_scopes() {
        assert_eq!(
            parse_scopes("orchestration:read terminal:operate").expect("scopes"),
            ["orchestration:read", "terminal:operate"]
        );
        for invalid in ["", "unknown:scope", "orchestration:read orchestration:read"] {
            assert!(matches!(
                parse_scopes(invalid),
                Err(AuthError::InvalidScope)
            ));
        }
    }

    #[tokio::test]
    async fn credential_issuance_prunes_expired_state_and_caps_active_memory() {
        let service = service();
        let now = now_ms();
        {
            let mut state = service.state.lock().await;
            for index in 0..MAX_ACTIVE_PAIRINGS {
                let id = format!("pairing-{index}");
                state.pairings.insert(
                    id.clone(),
                    PairingRecord {
                        id,
                        credential: format!("CREDENTIAL{index}"),
                        scopes: owned_scopes(STANDARD_SCOPES),
                        subject: "test".to_owned(),
                        label: None,
                        proof_key_thumbprint: None,
                        created_at_ms: now,
                        expires_at_ms: now + PAIRING_TTL_MS,
                        consumed_at_ms: None,
                        revoked_at_ms: None,
                    },
                );
            }
        }
        assert!(matches!(
            service
                .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
                .await,
            Err(AuthError::Internal(message)) if message == "active pairing capacity exceeded"
        ));
        service
            .state
            .lock()
            .await
            .pairings
            .get_mut("pairing-0")
            .expect("pairing fixture")
            .expires_at_ms = now - 1;
        service
            .issue_pairing(owned_scopes(STANDARD_SCOPES), None)
            .await
            .expect("expired pairing frees capacity");
        assert_eq!(
            service.state.lock().await.pairings.len(),
            MAX_ACTIVE_PAIRINGS
        );

        {
            let mut state = service.state.lock().await;
            for index in 0..MAX_ACTIVE_SESSIONS {
                let session_id = format!("session-{index}");
                state.sessions.insert(
                    session_id.clone(),
                    SessionRecord {
                        session_id,
                        subject: "test".to_owned(),
                        scopes: owned_scopes(STANDARD_SCOPES),
                        method: "bearer-access-token".to_owned(),
                        client: ClientMetadata::default(),
                        issued_at_ms: now,
                        expires_at_ms: now + SESSION_TTL_MS,
                        revoked_at_ms: None,
                        last_connected_at_ms: None,
                        connected_count: 0,
                        proof_key_thumbprint: None,
                    },
                );
            }
        }
        assert!(matches!(
            service
                .exchange_bootstrap(
                    "desktop-test-seed",
                    None,
                    ClientMetadata::default(),
                    None,
                )
                .await,
            Err(AuthError::Internal(message)) if message == "active session capacity exceeded"
        ));
    }
}
