use std::{net::SocketAddr, sync::Arc};

use thiserror::Error;
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{
    auth::{AuthService, SecretStore},
    config::ServerConfig,
    http, logging,
    persistence::{Database, Repositories, StatePaths, run_migrations},
    production::http_routes::{HttpRouteError, HttpRoutesState},
    production::runtime::ProductionRuntime,
    production::{
        connect_mcp::{
            ConnectMcpConfig, ConnectMcpService, PairingCredential, PairingIssuer, PreviewInvoker,
        },
        jwt::PersistentJwtCodec,
        managed_endpoint::ManagedEndpointRuntime,
    },
    rpc::RpcRegistry,
};

const SIGNING_KEY_NAME: &str = "server-signing-key";
const SIGNING_KEY_BYTES: usize = 32;
const ASSET_KEY_NAME: &str = "asset-access-key";
const ASSET_KEY_BYTES: usize = 32;

pub struct ServerRuntime;

pub struct ServerHandle {
    local_addr: SocketAddr,
    startup_access: Option<StartupAccess>,
    _database: Database,
    _production_runtime: Option<Arc<ProductionRuntime>>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<Result<(), std::io::Error>>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartupAccess {
    pub connection_string: String,
    pub credential: String,
    pub pairing_url: String,
}

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("failed to create the server base directory")]
    CreateBaseDirectory(#[source] std::io::Error),
    #[error("failed to initialize native server state files: {0}")]
    StateFiles(String),
    #[error("failed to initialize native server logging: {0}")]
    Logging(String),
    #[error("failed to bind the server listener")]
    Bind(#[source] std::io::Error),
    #[error("failed to initialize environment authentication: {0}")]
    AuthInitialize(String),
    #[error("failed to initialize SQLite persistence: {0}")]
    PersistenceInitialize(String),
    #[error("failed to initialize the native production runtime: {0}")]
    ProductionInitialize(String),
    #[error("the server task failed")]
    Serve(#[source] std::io::Error),
    #[error("the server task was cancelled unexpectedly")]
    Join(#[source] tokio::task::JoinError),
    #[error("the server task was already joined")]
    AlreadyJoined,
}

impl ServerRuntime {
    pub async fn start(config: ServerConfig) -> Result<ServerHandle, ServerError> {
        Self::start_internal(config, None).await
    }

    pub async fn start_with_registry(
        config: ServerConfig,
        rpc_registry: RpcRegistry,
    ) -> Result<ServerHandle, ServerError> {
        Self::start_internal(config, Some(rpc_registry)).await
    }

    async fn start_internal(
        config: ServerConfig,
        custom_registry: Option<RpcRegistry>,
    ) -> Result<ServerHandle, ServerError> {
        tokio::fs::create_dir_all(&config.base_dir)
            .await
            .map_err(ServerError::CreateBaseDirectory)?;
        let state_paths = StatePaths::from_config(&config);
        state_paths
            .ensure_directories()
            .await
            .map_err(|error| ServerError::StateFiles(error.to_string()))?;
        logging::initialize(&state_paths.server_log)
            .map_err(|error| ServerError::Logging(error.to_string()))?;
        let database = Database::open(config.database_path())
            .await
            .map_err(|error| ServerError::PersistenceInitialize(error.to_string()))?;
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .map_err(|error| ServerError::PersistenceInitialize(error.to_string()))?;
        let listener = TcpListener::bind((config.host.as_str(), config.port))
            .await
            .map_err(ServerError::Bind)?;
        let local_addr = listener.local_addr().map_err(ServerError::Bind)?;
        let state_directory = config.base_dir.join(if config.dev_url.is_some() {
            "dev"
        } else {
            "userdata"
        });
        let secret_store = SecretStore::new(state_directory.join("secrets"))
            .await
            .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
        let signing_secret = secret_store
            .get_or_create_random(SIGNING_KEY_NAME, SIGNING_KEY_BYTES)
            .await
            .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
        let asset_secret = secret_store
            .get_or_create_random(ASSET_KEY_NAME, ASSET_KEY_BYTES)
            .await
            .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
        let auth = AuthService::new_with_persistence(
            &config,
            signing_secret,
            secret_store,
            Repositories::new(database.clone()),
        )
        .await
        .map_err(|error| ServerError::AuthInitialize(format!("{error:?}")))?;
        let startup_access =
            if config.mode == crate::config::ServerMode::Web && !config.unsafe_no_auth {
                let issued = auth
                    .issue_startup_pairing()
                    .await
                    .map_err(|error| ServerError::AuthInitialize(format!("{error:?}")))?;
                Some(build_startup_access(local_addr, issued.credential)?)
            } else {
                None
            };
        let (rpc_registry, http_routes, production_runtime) = match custom_registry {
            Some(mut registry) => {
                crate::auth::register_rpc_handlers(&mut registry, auth.clone());
                (registry, fallback_http_routes(auth.clone()), None)
            }
            None => {
                let runtime = Arc::new(
                    ProductionRuntime::start(&config, database.clone(), auth.clone(), asset_secret)
                        .await
                        .map_err(ServerError::ProductionInitialize)?,
                );
                let jwt = PersistentJwtCodec::open(state_directory.join("environment-jwt.json"))
                    .await
                    .map_err(|error| ServerError::ProductionInitialize(error.to_string()))?;
                let endpoint = ManagedEndpointRuntime::default();
                let pairing_auth = auth.clone();
                let pairing = PairingIssuer::new(move |thumbprint| {
                    let auth = pairing_auth.clone();
                    async move {
                        auth.issue_cloud_pairing(thumbprint)
                            .await
                            .map(|issued| PairingCredential {
                                credential: issued.credential,
                                expires_at: issued.expires_at,
                            })
                            .map_err(|error| format!("{error:?}"))
                    }
                });
                let automation = runtime.preview_automation.clone();
                let preview = PreviewInvoker::new(
                    move |scope, operation, input, tab_id, cancellation| {
                        let automation = automation.clone();
                        async move {
                            let operation = crate::mcp::preview_automation::PreviewAutomationOperation::from_wire(&operation)
                                .ok_or_else(|| format!("unsupported preview operation: {operation}"))?;
                            automation
                                .invoke(
                                    crate::mcp::preview_automation::PreviewAutomationInvokeInput {
                                        environment_id: scope.environment_id,
                                        thread_id: scope.thread_id,
                                        provider_session_id: scope.provider_session_id,
                                        provider_instance_id: scope.provider_instance_id,
                                        operation,
                                        input,
                                        tab_id,
                                        timeout_ms: None,
                                    },
                                )
                                .await
                                .map_err(|error| format!("{}: {}", error.tag(), error.message()))
                                .and_then(|value| {
                                    if cancellation.is_cancelled() {
                                        Err("preview automation request was cancelled".to_owned())
                                    } else {
                                        Ok(value)
                                    }
                                })
                        }
                    },
                );
                let descriptor = serde_json::json!({
                    "environmentId": config.environment_id,
                    "label": config.environment_label,
                    "platform": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
                    "serverVersion": config.server_version,
                    "capabilities": { "repositoryIdentity": true },
                });
                let connect = Arc::new(
                    ConnectMcpService::open(
                        config.database_path(),
                        ConnectMcpConfig {
                            environment_id: config.environment_id.clone(),
                            descriptor,
                            mcp_endpoint: format!("http://{local_addr}/mcp"),
                            now_epoch_seconds: Arc::new(|| {
                                time::OffsetDateTime::now_utc().unix_timestamp()
                            }),
                            max_mcp_credentials: 1_024,
                            max_mcp_sessions: 1_024,
                        },
                        jwt.jwt_codec(),
                        endpoint.endpoint(),
                        pairing,
                        preview,
                    )
                    .await
                    .map_err(|error| ServerError::ProductionInitialize(format!("{error:?}")))?,
                );
                runtime.attach_connect_mcp(connect.clone()).await;
                (
                    runtime.registry.clone(),
                    core_http_routes(auth.clone(), runtime.clone(), connect),
                    Some(runtime),
                )
            }
        };
        let shutdown = CancellationToken::new();
        let app = http::build_router(http::AppState {
            config: Arc::new(config),
            shutdown: shutdown.clone(),
            rpc_registry,
            http_routes,
            auth,
        });
        let server_shutdown = shutdown.clone();
        let completion_signal = shutdown.clone();
        let cleanup_runtime = production_runtime.clone();
        let task = tokio::spawn(async move {
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(server_shutdown.cancelled_owned())
                .await;
            if let Some(runtime) = cleanup_runtime {
                runtime.shutdown().await;
            }
            completion_signal.cancel();
            result
        });

        Ok(ServerHandle {
            local_addr,
            startup_access,
            _database: database,
            _production_runtime: production_runtime,
            shutdown,
            task: Some(task),
        })
    }
}

fn core_http_routes(
    auth: AuthService,
    runtime: Arc<ProductionRuntime>,
    connect: Arc<ConnectMcpService>,
) -> HttpRoutesState {
    let authorize = authorize_handler(auth);
    let json_runtime = runtime.clone();
    let json_connect = connect.clone();
    let json = Arc::new(move |operation, payload, context| {
        let runtime = json_runtime.clone();
        let connect = json_connect.clone();
        Box::pin(async move {
            match operation {
                crate::production::http_routes::JsonOperation::ConnectLinkProof
                | crate::production::http_routes::JsonOperation::ConnectRelayConfig
                | crate::production::http_routes::JsonOperation::ConnectLinkState
                | crate::production::http_routes::JsonOperation::ConnectUnlink
                | crate::production::http_routes::JsonOperation::ConnectHealth
                | crate::production::http_routes::JsonOperation::ConnectMintCredential => {
                    connect.json_http(operation, payload, context).await
                }
                _ => runtime.json(operation, payload, context).await,
            }
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let diagnostic_runtime = runtime.clone();
    let diagnostic_logs = Arc::new(move |frontend_log, _context| {
        let runtime = diagnostic_runtime.clone();
        Box::pin(async move { runtime.diagnostic_logs(frontend_log).await })
            as crate::production::http_routes::BoxFuture<_>
    });
    let asset_runtime = runtime;
    let assets = Arc::new(move |token, path, _context| {
        let runtime = asset_runtime.clone();
        Box::pin(async move { runtime.asset(token, path).await })
            as crate::production::http_routes::BoxFuture<_>
    });
    let mcp = Arc::new(move |method, body, context| {
        let connect = connect.clone();
        Box::pin(async move { connect.mcp_http(method, body, context).await })
            as crate::production::http_routes::BoxFuture<_>
    });
    HttpRoutesState::new(authorize, json, diagnostic_logs, assets, mcp)
}

fn authorize_handler(auth: AuthService) -> crate::production::http_routes::AuthorizeHandler {
    Arc::new(move |headers, method, uri, scope, _cancellation| {
        let auth = auth.clone();
        Box::pin(async move {
            crate::auth::authorize_http_request(&auth, &headers, &method, &uri, scope)
                .await
                .map(|_| ())
                .map_err(crate::auth::auth_error_response)
        }) as crate::production::http_routes::BoxFuture<_>
    })
}

fn fallback_http_routes(auth: AuthService) -> HttpRoutesState {
    let authorize = authorize_handler(auth);
    let json = Arc::new(move |_operation, _payload, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "_tag": "NativeRuntimeUnavailableError",
                    "message": "The native production runtime is unavailable."
                }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let assets = Arc::new(move |_token, _path, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::NOT_FOUND,
                serde_json::json!({ "_tag": "AssetNotFoundError" }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let diagnostic_logs = Arc::new(move |_frontend_log, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "_tag": "NativeRuntimeUnavailableError",
                    "message": "The native production runtime is unavailable."
                }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    let mcp = Arc::new(move |_method, _body, _context| {
        Box::pin(async move {
            Err(HttpRouteError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "_tag": "McpUnavailableError" }),
            ))
        }) as crate::production::http_routes::BoxFuture<_>
    });
    HttpRoutesState::new(authorize, json, diagnostic_logs, assets, mcp)
}

impl ServerHandle {
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    #[must_use]
    pub fn startup_access(&self) -> Option<&StartupAccess> {
        self.startup_access.as_ref()
    }

    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    pub async fn wait_for_shutdown(&self) {
        self.shutdown.cancelled().await;
    }

    pub async fn join(mut self) -> Result<(), ServerError> {
        let task = self.task.take().ok_or(ServerError::AlreadyJoined)?;
        task.await
            .map_err(ServerError::Join)?
            .map_err(ServerError::Serve)
    }
}

fn build_startup_access(
    local_addr: SocketAddr,
    credential: String,
) -> Result<StartupAccess, ServerError> {
    let host = if local_addr.ip().is_unspecified() {
        "localhost".to_owned()
    } else {
        local_addr.ip().to_string()
    };
    let authority = if local_addr.is_ipv6() && !local_addr.ip().is_unspecified() {
        format!("[{host}]:{}", local_addr.port())
    } else {
        format!("{host}:{}", local_addr.port())
    };
    let connection_string = format!("http://{authority}");
    let mut pairing_url = url::Url::parse(&connection_string)
        .map_err(|error| ServerError::AuthInitialize(error.to_string()))?;
    pairing_url.set_path("/pair");
    pairing_url.set_query(None);
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", &credential)
        .finish();
    pairing_url.set_fragment(Some(&fragment));
    Ok(StartupAccess {
        connection_string,
        credential,
        pairing_url: pairing_url.to_string(),
    })
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn server_runtime_covers_production_fallback_startup_access_and_shutdown_paths() {
        let _logging_guard = crate::logging::TEST_INITIALIZE_LOCK.lock().await;
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let production_state = tempfile::tempdir().expect("production state directory");
        let production_config =
            ServerConfig::new(production_state.path()).with_bind("127.0.0.1", 0);
        let production = ServerRuntime::start(production_config)
            .await
            .expect("production server should start");
        let startup = production
            .startup_access()
            .expect("web server should issue startup access")
            .clone();
        let client = reqwest::Client::new();
        let descriptor = reqwest::get(format!(
            "http://{}/.well-known/t4code/environment",
            production.local_addr()
        ))
        .await
        .expect("environment descriptor should respond");
        assert!(descriptor.status().is_success());
        let token = client
            .post(format!("http://{}/oauth/token", production.local_addr()))
            .form(&[
                (
                    "grant_type",
                    "urn:ietf:params:oauth:grant-type:token-exchange",
                ),
                ("subject_token", startup.credential.as_str()),
                (
                    "subject_token_type",
                    "urn:t4code:params:oauth:token-type:environment-bootstrap",
                ),
                (
                    "requested_token_type",
                    "urn:ietf:params:oauth:token-type:access_token",
                ),
            ])
            .send()
            .await
            .expect("startup credential should exchange")
            .json::<serde_json::Value>()
            .await
            .expect("token response should decode");
        let snapshot = client
            .get(format!(
                "http://{}/api/orchestration/snapshot",
                production.local_addr()
            ))
            .bearer_auth(token["access_token"].as_str().expect("access token"))
            .send()
            .await
            .expect("orchestration snapshot should respond");
        assert!(snapshot.status().is_success());
        let link_state = client
            .get(format!(
                "http://{}/api/connect/link-state",
                production.local_addr()
            ))
            .bearer_auth(token["access_token"].as_str().expect("access token"))
            .send()
            .await
            .expect("connect link state should respond");
        assert!(link_state.status().is_success());
        let diagnostic = client
            .post(format!(
                "http://{}/api/diagnostics/logs.zip",
                production.local_addr()
            ))
            .bearer_auth(token["access_token"].as_str().expect("access token"))
            .json(&serde_json::json!({"frontendLog":"unit lifecycle log"}))
            .send()
            .await
            .expect("diagnostic logs should respond");
        assert!(diagnostic.status().is_success());
        production.shutdown();
        production.wait_for_shutdown().await;
        production
            .join()
            .await
            .expect("production server should join");

        let fallback_state = tempfile::tempdir().expect("fallback state directory");
        let fallback_config = ServerConfig::new(fallback_state.path()).with_bind("127.0.0.1", 0);
        let fallback = ServerRuntime::start_with_registry(fallback_config, RpcRegistry::empty())
            .await
            .expect("fallback server should start");
        let fallback_credential = fallback
            .startup_access()
            .expect("fallback server should issue startup access")
            .credential
            .clone();
        let fallback_token = client
            .post(format!("http://{}/oauth/token", fallback.local_addr()))
            .form(&[
                (
                    "grant_type",
                    "urn:ietf:params:oauth:grant-type:token-exchange",
                ),
                ("subject_token", fallback_credential.as_str()),
                (
                    "subject_token_type",
                    "urn:t4code:params:oauth:token-type:environment-bootstrap",
                ),
                (
                    "requested_token_type",
                    "urn:ietf:params:oauth:token-type:access_token",
                ),
            ])
            .send()
            .await
            .expect("fallback startup credential should exchange")
            .json::<serde_json::Value>()
            .await
            .expect("fallback token response should decode");
        let response = client
            .post(format!(
                "http://{}/api/orchestration/dispatch",
                fallback.local_addr()
            ))
            .bearer_auth(
                fallback_token["access_token"]
                    .as_str()
                    .expect("fallback access token"),
            )
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("fallback route should respond");
        assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        for response in [
            client
                .post(format!(
                    "http://{}/api/diagnostics/logs.zip",
                    fallback.local_addr()
                ))
                .bearer_auth(
                    fallback_token["access_token"]
                        .as_str()
                        .expect("fallback access token"),
                )
                .json(&serde_json::json!({"frontendLog":"fallback"}))
                .send()
                .await
                .expect("fallback diagnostics should respond"),
            client
                .get(format!(
                    "http://{}/api/assets/token/file",
                    fallback.local_addr()
                ))
                .bearer_auth(
                    fallback_token["access_token"]
                        .as_str()
                        .expect("fallback access token"),
                )
                .send()
                .await
                .expect("fallback asset should respond"),
            client
                .post(format!("http://{}/mcp", fallback.local_addr()))
                .bearer_auth(
                    fallback_token["access_token"]
                        .as_str()
                        .expect("fallback access token"),
                )
                .body("{}")
                .send()
                .await
                .expect("fallback MCP should respond"),
        ] {
            assert!(response.status().is_client_error() || response.status().is_server_error());
        }
        fallback.shutdown();
        fallback.join().await.expect("fallback server should join");

        let ipv4 = build_startup_access(
            "0.0.0.0:3773".parse().expect("IPv4 socket address"),
            "pairing credential".to_string(),
        )
        .expect("IPv4 startup access should build");
        assert_eq!(ipv4.connection_string, "http://localhost:3773");
        assert!(ipv4.pairing_url.contains("token=pairing+credential"));

        let ipv6 = build_startup_access(
            "[::]:3774".parse().expect("IPv6 socket address"),
            "credential".to_string(),
        )
        .expect("IPv6 startup access should build");
        assert_eq!(ipv6.connection_string, "http://localhost:3774");
    }
}
