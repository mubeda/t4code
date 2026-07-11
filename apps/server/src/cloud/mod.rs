use std::{future::Future, pin::Pin, sync::Arc};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RelayClientStatus {
    Available {
        executable_path: String,
        source: String,
        version: String,
    },
    Missing {
        version: String,
    },
    Unsupported {
        platform: String,
        arch: String,
        version: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RelayClientInstallEvent {
    Progress { stage: String },
    Complete { status: RelayClientStatus },
}

type ResolveFuture = Pin<Box<dyn Future<Output = RelayClientStatus> + Send>>;
type InstallReportFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type InstallFuture = Pin<Box<dyn Future<Output = Result<RelayClientStatus, String>> + Send>>;
type InstallReporter = Arc<dyn Fn(RelayClientInstallEvent) -> InstallReportFuture + Send + Sync>;
type InstallCallback = Arc<dyn Fn(InstallReporter) -> InstallFuture + Send + Sync>;

#[derive(Clone)]
pub struct RelayClientService {
    resolve: Arc<dyn Fn() -> ResolveFuture + Send + Sync>,
    install: InstallCallback,
}

impl RelayClientService {
    pub fn new<Resolve, ResolveFut, Install, InstallFut>(resolve: Resolve, install: Install) -> Self
    where
        Resolve: Fn() -> ResolveFut + Send + Sync + 'static,
        ResolveFut: Future<Output = RelayClientStatus> + Send + 'static,
        Install: Fn(
                Arc<dyn Fn(RelayClientInstallEvent) -> InstallReportFuture + Send + Sync>,
            ) -> InstallFut
            + Send
            + Sync
            + 'static,
        InstallFut: Future<Output = Result<RelayClientStatus, String>> + Send + 'static,
    {
        Self {
            resolve: Arc::new(move || Box::pin(resolve()) as ResolveFuture),
            install: Arc::new(move |report| Box::pin(install(report)) as InstallFuture),
        }
    }

    pub async fn resolve(&self) -> RelayClientStatus {
        (self.resolve)().await
    }

    pub async fn install(&self) -> Result<Vec<RelayClientInstallEvent>, String> {
        let events = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let report = Arc::new({
            let events = events.clone();
            move |event: RelayClientInstallEvent| {
                let events = events.clone();
                Box::pin(async move {
                    events.lock().await.push(event);
                    Ok(())
                }) as InstallReportFuture
            }
        });
        let status = (self.install)(report.clone()).await?;
        events
            .lock()
            .await
            .push(RelayClientInstallEvent::Complete { status });
        Ok(events.lock().await.clone())
    }
}
