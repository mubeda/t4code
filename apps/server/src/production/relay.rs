use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use reqwest::Client;
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, OpenOptions},
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Semaphore,
    time::{sleep, timeout},
};
use uuid::Uuid;

use crate::{
    cloud::{RelayClientInstallEvent, RelayClientService, RelayClientStatus},
    process::configure_background_command,
};

type ReportFuture = std::pin::Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type InstallReporter = Arc<dyn Fn(RelayClientInstallEvent) -> ReportFuture + Send + Sync>;

pub const CLOUDFLARED_VERSION: &str = "2026.5.2";
pub const CLOUDFLARED_PATH_ENV_NAME: &str = "T4CODE_CLOUDFLARED_PATH";

const MAX_DOWNLOAD_BYTES: usize = 128 * 1024 * 1024;
const INSTALL_LOCK_RETRY_COUNT: usize = 100;
const INSTALL_LOCK_RETRY_DELAY: Duration = Duration::from_millis(100);
const INSTALL_LOCK_STALE_AFTER: Duration = Duration::from_secs(10 * 60);
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RelayReleaseArchive {
    Binary,
    Tgz,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayReleaseAsset {
    pub url: String,
    pub sha256: String,
    pub archive: RelayReleaseArchive,
}

impl RelayReleaseAsset {
    #[must_use]
    pub fn new(
        url: impl Into<String>,
        sha256: impl Into<String>,
        archive: RelayReleaseArchive,
    ) -> Self {
        Self {
            url: url.into(),
            sha256: sha256.into(),
            archive,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RelayClientOptions {
    base_dir: PathBuf,
    platform: String,
    arch: String,
    executable_override: Option<PathBuf>,
    search_path: Option<OsString>,
    release_asset: Option<RelayReleaseAsset>,
    download_timeout: Duration,
}

impl RelayClientOptions {
    #[must_use]
    pub fn new(
        base_dir: impl Into<PathBuf>,
        platform: impl Into<String>,
        arch: impl Into<String>,
    ) -> Self {
        let platform = platform.into();
        let arch = arch.into();
        let release_asset = release_asset(&platform, &arch);
        Self {
            base_dir: base_dir.into(),
            platform,
            arch,
            executable_override: None,
            search_path: std::env::var_os("PATH"),
            release_asset,
            download_timeout: Duration::from_secs(120),
        }
    }

    #[must_use]
    pub fn native(base_dir: impl Into<PathBuf>) -> Self {
        Self::new(base_dir, native_platform(), native_arch())
            .with_optional_executable_override(std::env::var_os(CLOUDFLARED_PATH_ENV_NAME))
    }

    #[must_use]
    pub fn with_executable_override(mut self, path: impl Into<PathBuf>) -> Self {
        self.executable_override = Some(path.into());
        self
    }

    #[must_use]
    pub fn with_optional_executable_override(mut self, path: Option<OsString>) -> Self {
        self.executable_override = path.filter(|value| !value.is_empty()).map(PathBuf::from);
        self
    }

    #[must_use]
    pub fn with_search_path(mut self, path: OsString) -> Self {
        self.search_path = Some(path);
        self
    }

    #[must_use]
    pub fn with_release_asset(mut self, asset: Option<RelayReleaseAsset>) -> Self {
        self.release_asset = asset;
        self
    }

    #[must_use]
    pub const fn with_download_timeout(mut self, duration: Duration) -> Self {
        self.download_timeout = duration;
        self
    }

    #[must_use]
    pub fn managed_executable_path(&self) -> PathBuf {
        self.base_dir
            .join("tools")
            .join("cloudflared")
            .join(CLOUDFLARED_VERSION)
            .join(format!("{}-{}", self.platform, self.arch))
            .join(executable_name(&self.platform))
    }
}

#[derive(Debug)]
struct RelayInstallError {
    reason: &'static str,
    message: String,
}

impl RelayInstallError {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RelayInstallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.reason, self.message)
    }
}

struct NativeRelayClient {
    options: RelayClientOptions,
    http: Client,
    install_permit: Semaphore,
}

impl NativeRelayClient {
    fn new(options: RelayClientOptions) -> Result<Self, String> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(options.download_timeout)
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("t4code/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| {
                format!("download_failed: could not initialize HTTP client: {error}")
            })?;
        Ok(Self {
            options,
            http,
            install_permit: Semaphore::new(1),
        })
    }

    async fn resolve(&self) -> RelayClientStatus {
        if let Some(path) = &self.options.executable_override {
            return if is_executable_file(path).await {
                self.available(path, "override")
            } else {
                self.missing()
            };
        }

        let managed = self.options.managed_executable_path();
        if is_executable_file(&managed).await {
            return self.available(&managed, "managed");
        }
        if let Some(path) = executable_on_path(
            self.options.search_path.as_deref(),
            executable_name(&self.options.platform),
        )
        .await
        {
            return self.available(&path, "path");
        }
        if self.options.release_asset.is_some() {
            self.missing()
        } else {
            RelayClientStatus::Unsupported {
                platform: self.options.platform.clone(),
                arch: self.options.arch.clone(),
                version: CLOUDFLARED_VERSION.to_owned(),
            }
        }
    }

    async fn install(&self, report: InstallReporter) -> Result<RelayClientStatus, String> {
        let _permit = self
            .install_permit
            .acquire()
            .await
            .map_err(|_| "install_locked: relay installer is shutting down".to_owned())?;
        self.install_unlocked(&report)
            .await
            .map_err(|error| error.to_string())
    }

    async fn install_unlocked(
        &self,
        report: &InstallReporter,
    ) -> Result<RelayClientStatus, RelayInstallError> {
        report_stage(report, "checking").await?;
        let existing = self.resolve().await;
        if matches!(existing, RelayClientStatus::Available { .. }) {
            return Ok(existing);
        }
        if self.options.executable_override.is_some() {
            return Err(RelayInstallError::new(
                "override_missing",
                format!("{CLOUDFLARED_PATH_ENV_NAME} does not point to an executable file."),
            ));
        }
        let asset = self.options.release_asset.as_ref().ok_or_else(|| {
            RelayInstallError::new(
                "unsupported_platform",
                format!(
                    "T4Code does not provide a managed relay client binary for {}-{}.",
                    self.options.platform, self.options.arch
                ),
            )
        })?;

        let managed = self.options.managed_executable_path();
        let parent = managed.parent().ok_or_else(|| {
            RelayInstallError::new("write_failed", "managed executable path has no parent")
        })?;
        fs::create_dir_all(parent).await.map_err(|error| {
            RelayInstallError::new(
                "write_failed",
                format!("could not create relay client tool directory: {error}"),
            )
        })?;
        report_stage(report, "waiting_for_lock").await?;
        let lock_path = managed.with_extension(format!(
            "{}lock",
            managed
                .extension()
                .and_then(OsStr::to_str)
                .map(|extension| format!("{extension}."))
                .unwrap_or_default()
        ));
        acquire_install_lock(&lock_path).await?;

        let result = self
            .install_while_locked(asset, &managed, parent, report)
            .await;
        let _ = fs::remove_file(&lock_path).await;
        result
    }

    async fn install_while_locked(
        &self,
        asset: &RelayReleaseAsset,
        managed: &Path,
        parent: &Path,
        report: &InstallReporter,
    ) -> Result<RelayClientStatus, RelayInstallError> {
        let after_lock = self.resolve().await;
        if matches!(after_lock, RelayClientStatus::Available { .. }) {
            return Ok(after_lock);
        }

        let temp_dir = parent.join(format!(".install-{}", Uuid::new_v4()));
        fs::create_dir(&temp_dir).await.map_err(|error| {
            RelayInstallError::new(
                "write_failed",
                format!("could not create temporary install directory: {error}"),
            )
        })?;
        let result = self
            .download_and_activate(asset, managed, &temp_dir, report)
            .await;
        let _ = fs::remove_dir_all(&temp_dir).await;
        result
    }

    async fn download_and_activate(
        &self,
        asset: &RelayReleaseAsset,
        managed: &Path,
        temp_dir: &Path,
        report: &InstallReporter,
    ) -> Result<RelayClientStatus, RelayInstallError> {
        report_stage(report, "downloading").await?;
        let download = temp_dir.join(match asset.archive {
            RelayReleaseArchive::Binary => executable_name(&self.options.platform),
            RelayReleaseArchive::Tgz => "cloudflared.tgz",
        });
        self.download(asset, &download).await?;

        report_stage(report, "verifying").await?;
        verify_checksum(&download, &asset.sha256).await?;
        report_stage(report, "installing").await?;

        let executable = temp_dir.join(executable_name(&self.options.platform));
        if asset.archive == RelayReleaseArchive::Tgz {
            run_checked(
                "tar",
                [
                    OsString::from("-xzf"),
                    download.as_os_str().to_owned(),
                    OsString::from("-C"),
                    temp_dir.as_os_str().to_owned(),
                ],
                "write_failed",
                "could not extract the relay client archive",
            )
            .await?;
        }
        make_executable(&executable).await?;

        report_stage(report, "validating").await?;
        run_checked(
            &executable,
            [OsString::from("--version")],
            "validation_failed",
            "downloaded relay client binary did not run",
        )
        .await?;

        report_stage(report, "activating").await?;
        let staged = managed.with_extension(format!(
            "{}{}.tmp",
            managed
                .extension()
                .and_then(OsStr::to_str)
                .map(|extension| format!("{extension}."))
                .unwrap_or_default(),
            Uuid::new_v4()
        ));
        fs::rename(&executable, &staged).await.map_err(|error| {
            RelayInstallError::new(
                "write_failed",
                format!("could not stage relay client executable: {error}"),
            )
        })?;
        let activation = fs::rename(&staged, managed).await.map_err(|error| {
            RelayInstallError::new(
                "write_failed",
                format!("could not atomically activate relay client executable: {error}"),
            )
        });
        if activation.is_err() {
            let _ = fs::remove_file(&staged).await;
        }
        activation?;
        Ok(self.available(managed, "managed"))
    }

    async fn download(
        &self,
        asset: &RelayReleaseAsset,
        destination: &Path,
    ) -> Result<(), RelayInstallError> {
        let mut response = self
            .http
            .get(&asset.url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| {
                RelayInstallError::new(
                    "download_failed",
                    format!("could not download relay client: {error}"),
                )
            })?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_DOWNLOAD_BYTES as u64)
        {
            return Err(RelayInstallError::new(
                "download_failed",
                "relay client download exceeds the size limit",
            ));
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .await
            .map_err(|error| {
                RelayInstallError::new(
                    "write_failed",
                    format!("could not create relay client download: {error}"),
                )
            })?;
        let mut received = 0_usize;
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            RelayInstallError::new(
                "download_failed",
                format!("could not read relay client download: {error}"),
            )
        })? {
            received = received.checked_add(chunk.len()).ok_or_else(|| {
                RelayInstallError::new("download_failed", "relay client download is too large")
            })?;
            if received > MAX_DOWNLOAD_BYTES {
                return Err(RelayInstallError::new(
                    "download_failed",
                    "relay client download exceeds the size limit",
                ));
            }
            file.write_all(&chunk).await.map_err(|error| {
                RelayInstallError::new(
                    "write_failed",
                    format!("could not write relay client download: {error}"),
                )
            })?;
        }
        file.flush().await.map_err(|error| {
            RelayInstallError::new(
                "write_failed",
                format!("could not flush relay client download: {error}"),
            )
        })
    }

    fn available(&self, path: &Path, source: &str) -> RelayClientStatus {
        RelayClientStatus::Available {
            executable_path: path.to_string_lossy().into_owned(),
            source: source.to_owned(),
            version: CLOUDFLARED_VERSION.to_owned(),
        }
    }

    fn missing(&self) -> RelayClientStatus {
        RelayClientStatus::Missing {
            version: CLOUDFLARED_VERSION.to_owned(),
        }
    }
}

#[must_use]
pub fn relay_client_service(base_dir: impl Into<PathBuf>) -> RelayClientService {
    relay_client_service_with_options(RelayClientOptions::native(base_dir))
}

#[must_use]
pub fn relay_client_service_with_options(options: RelayClientOptions) -> RelayClientService {
    let client = Arc::new(
        NativeRelayClient::new(options)
            .expect("the native relay HTTP client must initialize with static configuration"),
    );
    RelayClientService::new(
        {
            let client = Arc::clone(&client);
            move || {
                let client = Arc::clone(&client);
                async move { client.resolve().await }
            }
        },
        move |report| {
            let client = Arc::clone(&client);
            async move { client.install(report).await }
        },
    )
}

async fn report_stage(report: &InstallReporter, stage: &str) -> Result<(), RelayInstallError> {
    report(RelayClientInstallEvent::Progress {
        stage: stage.to_owned(),
    })
    .await
    .map_err(|error| RelayInstallError::new("write_failed", error))
}

async fn acquire_install_lock(path: &Path) -> Result<(), RelayInstallError> {
    for _ in 0..INSTALL_LOCK_RETRY_COUNT {
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .await
        {
            Ok(mut lock) => {
                lock.write_all(std::process::id().to_string().as_bytes())
                    .await
                    .map_err(|error| {
                        RelayInstallError::new(
                            "write_failed",
                            format!("could not write relay install lock: {error}"),
                        )
                    })?;
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(path).await {
                    let _ = fs::remove_file(path).await;
                    continue;
                }
                sleep(INSTALL_LOCK_RETRY_DELAY).await;
            }
            Err(error) => {
                return Err(RelayInstallError::new(
                    "write_failed",
                    format!("could not acquire relay install lock: {error}"),
                ));
            }
        }
    }
    Err(RelayInstallError::new(
        "install_locked",
        "another relay client installation is still in progress",
    ))
}

async fn lock_is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > INSTALL_LOCK_STALE_AFTER)
}

async fn verify_checksum(path: &Path, expected: &str) -> Result<(), RelayInstallError> {
    let mut file = fs::File::open(path).await.map_err(|error| {
        RelayInstallError::new(
            "validation_failed",
            format!("could not open downloaded relay client: {error}"),
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).await.map_err(|error| {
            RelayInstallError::new(
                "validation_failed",
                format!("could not read downloaded relay client: {error}"),
            )
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(RelayInstallError::new(
            "invalid_checksum",
            "downloaded relay client checksum did not match the pinned release",
        ))
    }
}

async fn run_checked<I, S>(
    program: impl AsRef<OsStr>,
    args: I,
    reason: &'static str,
    message: &'static str,
) -> Result<(), RelayInstallError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(program);
    configure_background_command(&mut command);
    command.args(args).kill_on_drop(true);
    let output = timeout(VALIDATION_TIMEOUT, command.output())
        .await
        .map_err(|_| RelayInstallError::new(reason, format!("{message}: timed out")))?
        .map_err(|error| RelayInstallError::new(reason, format!("{message}: {error}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(RelayInstallError::new(
            reason,
            format!("{message}: exited with {}", output.status),
        ))
    }
}

async fn make_executable(path: &Path) -> Result<(), RelayInstallError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|error| {
                RelayInstallError::new(
                    "write_failed",
                    format!("could not make relay client executable: {error}"),
                )
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

async fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path).await else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

async fn executable_on_path(path: Option<&OsStr>, name: &str) -> Option<PathBuf> {
    let paths = path.map(std::env::split_paths)?;
    for directory in paths {
        let candidate = directory.join(name);
        if is_executable_file(&candidate).await {
            return Some(candidate);
        }
    }
    None
}

fn executable_name(platform: &str) -> &'static str {
    if platform == "win32" {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

fn native_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn native_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

fn release_asset(platform: &str, arch: &str) -> Option<RelayReleaseAsset> {
    let (asset, checksum, archive) = match (platform, arch) {
        ("darwin", "arm64") => (
            "cloudflared-darwin-arm64.tgz",
            "ba94054c9fd4297645093d59d51442e5e546d07bb0516120e694a13d5b216d38",
            RelayReleaseArchive::Tgz,
        ),
        ("darwin", "x64") => (
            "cloudflared-darwin-amd64.tgz",
            "7240f709506bc2c1eb9da4d89cf2555499c60280ecb854b7d80e8f17d4b7903d",
            RelayReleaseArchive::Tgz,
        ),
        ("linux", "arm64") => (
            "cloudflared-linux-arm64",
            "5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815",
            RelayReleaseArchive::Binary,
        ),
        ("linux", "x64") => (
            "cloudflared-linux-amd64",
            "5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886",
            RelayReleaseArchive::Binary,
        ),
        ("win32", "x64") => (
            "cloudflared-windows-amd64.exe",
            "20b9638f685333d623798e733effbad2487093f15ba592f6c7752360ff3b7ab7",
            RelayReleaseArchive::Binary,
        ),
        _ => return None,
    };
    Some(RelayReleaseAsset::new(
        format!(
            "https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{asset}"
        ),
        checksum,
        archive,
    ))
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, sync::Mutex};

    use sha2::{Digest, Sha256};
    use tempfile::TempDir;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn native_relay_client_covers_resolution_installation_and_private_helpers() {
        use std::os::unix::fs::PermissionsExt;

        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("temp dir");
        let fixture = Path::new("/usr/bin/true");
        let executable = temp.path().join("cloudflared");
        fs::copy(fixture, &executable).await.expect("copy fixture");
        fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o644))
            .await
            .expect("non-executable permissions");

        assert!(!is_executable_file(&temp.path().join("missing")).await);
        assert!(!is_executable_file(temp.path()).await);
        assert!(!is_executable_file(&executable).await);
        make_executable(&executable).await.expect("make executable");
        assert!(is_executable_file(&executable).await);
        assert!(make_executable(&temp.path().join("missing")).await.is_err());
        assert_eq!(executable_name("win32"), "cloudflared.exe");
        assert_eq!(executable_name("linux"), "cloudflared");
        assert!(!native_platform().is_empty());
        assert!(!native_arch().is_empty());
        assert!(release_asset("darwin", "arm64").is_some());
        assert!(release_asset("darwin", "x64").is_some());
        assert!(release_asset("linux", "arm64").is_some());
        assert!(release_asset("linux", "x64").is_some());
        assert!(release_asset("win32", "x64").is_some());
        assert!(release_asset("plan9", "mips").is_none());

        let search_path = std::env::join_paths([temp.path()]).expect("search path");
        assert_eq!(
            executable_on_path(Some(search_path.as_os_str()), "cloudflared").await,
            Some(executable.clone())
        );
        assert_eq!(executable_on_path(None, "cloudflared").await, None);

        let payload = b"relay fixture";
        let payload_path = temp.path().join("payload");
        fs::write(&payload_path, payload)
            .await
            .expect("write payload");
        let checksum = format!("{:x}", Sha256::digest(payload));
        verify_checksum(&payload_path, &checksum)
            .await
            .expect("valid checksum");
        assert_eq!(
            verify_checksum(&payload_path, &"00".repeat(32))
                .await
                .expect_err("checksum mismatch")
                .reason,
            "invalid_checksum"
        );
        assert_eq!(
            verify_checksum(&temp.path().join("missing"), &checksum)
                .await
                .expect_err("missing checksum input")
                .reason,
            "validation_failed"
        );

        let lock_path = temp.path().join("install.lock");
        assert!(!lock_is_stale(&lock_path).await);
        acquire_install_lock(&lock_path)
            .await
            .expect("install lock");
        assert!(!lock_is_stale(&lock_path).await);
        fs::remove_file(&lock_path).await.expect("remove lock");

        run_checked(
            "/usr/bin/true",
            [OsString::from("--version")],
            "validation_failed",
            "true failed",
        )
        .await
        .expect("successful command");
        run_checked(
            "/usr/bin/true",
            [
                OsString::from("one"),
                OsString::from("two"),
                OsString::from("three"),
                OsString::from("four"),
            ],
            "validation_failed",
            "true failed",
        )
        .await
        .expect("successful four-argument command");
        assert_eq!(
            run_checked(
                "/usr/bin/false",
                [OsString::from("--version")],
                "validation_failed",
                "false unexpectedly succeeded",
            )
            .await
            .expect_err("non-zero command")
            .reason,
            "validation_failed"
        );
        assert_eq!(
            run_checked(
                temp.path().join("missing-command"),
                [OsString::from("--version")],
                "validation_failed",
                "missing command unexpectedly succeeded",
            )
            .await
            .expect_err("missing command")
            .reason,
            "validation_failed"
        );

        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        let reporter: InstallReporter = Arc::new(move |event| {
            let captured_events = Arc::clone(&captured_events);
            Box::pin(async move {
                captured_events.lock().expect("event lock").push(event);
                Ok(())
            })
        });
        report_stage(&reporter, "checking")
            .await
            .expect("report stage");
        assert_eq!(events.lock().expect("event lock").len(), 1);

        let failing_reporter: InstallReporter =
            Arc::new(|_| Box::pin(async { Err("report failed".to_owned()) }));
        let report_error = report_stage(&failing_reporter, "checking")
            .await
            .expect_err("report failure");
        assert_eq!(report_error.reason, "write_failed");
        assert_eq!(report_error.to_string(), "write_failed: report failed");

        let override_options = RelayClientOptions::new(temp.path(), "linux", "x64")
            .with_optional_executable_override(Some(executable.clone().into_os_string()))
            .with_search_path(OsString::new())
            .with_release_asset(None)
            .with_download_timeout(Duration::from_secs(5));
        let direct_override = RelayClientOptions::new(temp.path(), "linux", "x64")
            .with_executable_override(executable.clone());
        assert_eq!(
            direct_override.executable_override,
            Some(executable.clone())
        );
        let override_client = NativeRelayClient::new(override_options).expect("override client");
        assert!(matches!(
            override_client.resolve().await,
            RelayClientStatus::Available { source, .. } if source == "override"
        ));
        fs::remove_file(&executable)
            .await
            .expect("remove override fixture");
        assert_eq!(override_client.resolve().await, override_client.missing());
        assert!(
            override_client
                .install(Arc::clone(&reporter))
                .await
                .is_err()
        );

        let unsupported_options = RelayClientOptions::new(temp.path(), "plan9", "mips")
            .with_optional_executable_override(Some(OsString::new()))
            .with_search_path(OsString::new());
        let unsupported_client =
            NativeRelayClient::new(unsupported_options).expect("unsupported client");
        assert!(matches!(
            unsupported_client.resolve().await,
            RelayClientStatus::Unsupported { .. }
        ));
        assert!(
            unsupported_client
                .install(Arc::clone(&reporter))
                .await
                .expect_err("unsupported install")
                .contains("unsupported_platform")
        );

        let fixture_bytes = fs::read(fixture).await.expect("read fixture");
        let fixture_checksum = format!("{:x}", Sha256::digest(&fixture_bytes));
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
        let address = listener.local_addr().expect("server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await.expect("read request");
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                fixture_bytes.len()
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("write headers");
            socket
                .write_all(&fixture_bytes)
                .await
                .expect("write fixture");
        });
        let asset = RelayReleaseAsset::new(
            format!("http://{address}/cloudflared"),
            fixture_checksum,
            RelayReleaseArchive::Binary,
        );
        let install_options = RelayClientOptions::new(temp.path().join("install"), "linux", "x64")
            .with_search_path(OsString::new())
            .with_release_asset(Some(asset))
            .with_download_timeout(Duration::from_secs(5));
        let managed = install_options.managed_executable_path();
        let service = relay_client_service_with_options(install_options);
        let install_events = service.install().await.expect("install relay");
        server.await.expect("server task");
        assert!(managed.is_file());
        assert!(matches!(
            install_events.last(),
            Some(RelayClientInstallEvent::Complete {
                status: RelayClientStatus::Available { source, .. }
            }) if source == "managed"
        ));
        assert!(matches!(
            service.resolve().await,
            RelayClientStatus::Available { source, .. } if source == "managed"
        ));

        let native_service = relay_client_service(temp.path().join("native"));
        assert_eq!(
            match native_service.resolve().await {
                RelayClientStatus::Available { version, .. }
                | RelayClientStatus::Missing { version }
                | RelayClientStatus::Unsupported { version, .. } => version,
            },
            CLOUDFLARED_VERSION
        );
    }
}
