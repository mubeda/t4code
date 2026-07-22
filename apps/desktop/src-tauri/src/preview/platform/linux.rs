use std::sync::mpsc;
use std::thread::{self, ThreadId};
use std::time::Duration;

use cairo::ImageSurface;
use webkit2gtk::{
    SnapshotOptions, SnapshotRegion, WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes,
};

use super::{ClearDataKinds, PlatformWebviewOps, PreviewPlatformError, json_envelope};

const PLATFORM_CALL_TIMEOUT: Duration = Duration::from_secs(10);

pub struct LinuxWebviewOps;

fn unavailable(context: &str, error: impl std::fmt::Display) -> PreviewPlatformError {
    PreviewPlatformError::Unavailable(format!("{context}: {error}"))
}

fn completion_wait_guard(
    caller_thread: ThreadId,
    webview_thread: ThreadId,
) -> Result<(), PreviewPlatformError> {
    if caller_thread == webview_thread {
        Err(PreviewPlatformError::Unavailable(
            "completion-based preview platform calls cannot wait on the WebKitGTK UI thread"
                .to_string(),
        ))
    } else {
        Ok(())
    }
}

fn website_data_types(kinds: ClearDataKinds) -> WebsiteDataTypes {
    let mut types = WebsiteDataTypes::empty();
    if kinds.cookies {
        types |= WebsiteDataTypes::COOKIES;
    }
    if kinds.cache {
        types |= WebsiteDataTypes::MEMORY_CACHE | WebsiteDataTypes::DISK_CACHE;
    }
    if kinds.storage {
        types |= WebsiteDataTypes::SESSION_STORAGE
            | WebsiteDataTypes::LOCAL_STORAGE
            | WebsiteDataTypes::INDEXEDDB_DATABASES;
    }
    types
}

fn surface_to_png(surface: cairo::Surface) -> Result<Vec<u8>, PreviewPlatformError> {
    let image_surface = ImageSurface::try_from(surface).map_err(|surface| {
        PreviewPlatformError::Unavailable(format!(
            "snapshot did not return an image surface (got {:?})",
            surface.type_()
        ))
    })?;
    let mut png = Vec::new();
    image_surface
        .write_to_png(&mut png)
        .map_err(|error| unavailable("failed to encode preview snapshot as PNG", error))?;
    if png.is_empty() {
        return Err(PreviewPlatformError::Unavailable(
            "preview snapshot PNG was empty".to_string(),
        ));
    }
    Ok(png)
}

/// Run `f` with the WebKitGTK webview on the GTK UI thread and post the result back.
fn with_webkit<T: Send + 'static>(
    webview: &tauri::Webview,
    f: impl FnOnce(&webkit2gtk::WebView) -> Result<T, PreviewPlatformError> + Send + 'static,
) -> Result<T, PreviewPlatformError> {
    let (tx, rx) = mpsc::sync_channel::<Result<T, PreviewPlatformError>>(1);
    webview
        .with_webview(move |platform| {
            let webview = platform.inner();
            let _ = tx.send(f(&webview));
        })
        .map_err(|error| PreviewPlatformError::Unavailable(error.to_string()))?;
    rx.recv_timeout(PLATFORM_CALL_TIMEOUT)
        .map_err(|_| PreviewPlatformError::Timeout)?
}

impl PlatformWebviewOps for LinuxWebviewOps {
    fn eval_json(
        webview: &tauri::Webview,
        js: &str,
        timeout: Duration,
    ) -> Result<String, PreviewPlatformError> {
        let caller_thread = thread::current().id();
        let script = json_envelope(js);
        let (tx, rx) = mpsc::sync_channel::<Result<String, PreviewPlatformError>>(1);
        webview
            .with_webview(move |platform| {
                if let Err(error) = completion_wait_guard(caller_thread, thread::current().id()) {
                    let _ = tx.send(Err(error));
                    return;
                }

                let webview = platform.inner();
                webview.evaluate_javascript(
                    &script,
                    None,
                    None,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        let outcome = result
                            .map(|value| value.to_string())
                            .map_err(|error| PreviewPlatformError::Js(error.to_string()));
                        let _ = tx.send(outcome);
                    },
                );
            })
            .map_err(|error| PreviewPlatformError::Unavailable(error.to_string()))?;
        rx.recv_timeout(timeout)
            .map_err(|_| PreviewPlatformError::Timeout)?
    }

    fn title(webview: &tauri::Webview) -> Result<String, PreviewPlatformError> {
        with_webkit(webview, |webview| {
            Ok(webview
                .title()
                .map(|title| title.to_string())
                .unwrap_or_default())
        })
    }

    fn can_go_back(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError> {
        with_webkit(webview, |webview| Ok(webview.can_go_back()))
    }

    fn can_go_forward(webview: &tauri::Webview) -> Result<bool, PreviewPlatformError> {
        with_webkit(webview, |webview| Ok(webview.can_go_forward()))
    }

    fn go_back(webview: &tauri::Webview) -> Result<(), PreviewPlatformError> {
        with_webkit(webview, |webview| {
            webview.go_back();
            Ok(())
        })
    }

    fn go_forward(webview: &tauri::Webview) -> Result<(), PreviewPlatformError> {
        with_webkit(webview, |webview| {
            webview.go_forward();
            Ok(())
        })
    }

    fn hard_reload(webview: &tauri::Webview) -> Result<(), PreviewPlatformError> {
        with_webkit(webview, |webview| {
            webview.reload_bypass_cache();
            Ok(())
        })
    }

    fn screenshot_png(
        webview: &tauri::Webview,
        timeout: Duration,
    ) -> Result<Vec<u8>, PreviewPlatformError> {
        let caller_thread = thread::current().id();
        let (tx, rx) = mpsc::sync_channel::<Result<Vec<u8>, PreviewPlatformError>>(1);
        webview
            .with_webview(move |platform| {
                if let Err(error) = completion_wait_guard(caller_thread, thread::current().id()) {
                    let _ = tx.send(Err(error));
                    return;
                }

                let webview = platform.inner();
                webview.snapshot(
                    SnapshotRegion::Visible,
                    SnapshotOptions::NONE,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        let outcome = result
                            .map_err(|error| unavailable("WebKitGTK snapshot failed", error))
                            .and_then(surface_to_png);
                        let _ = tx.send(outcome);
                    },
                );
            })
            .map_err(|error| PreviewPlatformError::Unavailable(error.to_string()))?;
        rx.recv_timeout(timeout)
            .map_err(|_| PreviewPlatformError::Timeout)?
    }

    fn clear_data(
        webview: &tauri::Webview,
        kinds: ClearDataKinds,
    ) -> Result<(), PreviewPlatformError> {
        let caller_thread = thread::current().id();
        let data_types = website_data_types(kinds);
        let (tx, rx) = mpsc::sync_channel::<Result<(), PreviewPlatformError>>(1);
        webview
            .with_webview(move |platform| {
                if let Err(error) = completion_wait_guard(caller_thread, thread::current().id()) {
                    let _ = tx.send(Err(error));
                    return;
                }
                if data_types.is_empty() {
                    let _ = tx.send(Ok(()));
                    return;
                }

                let webview = platform.inner();
                let Some(manager) = webview.website_data_manager() else {
                    let _ = tx.send(Err(PreviewPlatformError::Unavailable(
                        "WebKitGTK website data manager is unavailable".to_string(),
                    )));
                    return;
                };
                manager.clear(
                    data_types,
                    webkit2gtk::glib::TimeSpan::from_seconds(0),
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        let outcome = result.map_err(|error| {
                            unavailable("WebKitGTK website data clear failed", error)
                        });
                        let _ = tx.send(outcome);
                    },
                );
            })
            .map_err(|error| PreviewPlatformError::Unavailable(error.to_string()))?;
        rx.recv_timeout(PLATFORM_CALL_TIMEOUT)
            .map_err(|_| PreviewPlatformError::Timeout)?
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;

    use cairo::{Format, ImageSurface};

    use super::{completion_wait_guard, surface_to_png, website_data_types};
    use crate::preview::platform::{ClearDataKinds, PreviewPlatformError};

    #[test]
    fn completion_wait_guard_rejects_the_webview_thread() {
        let thread_id = thread::current().id();
        let error = completion_wait_guard(thread_id, thread_id).unwrap_err();
        assert!(matches!(
            error,
            PreviewPlatformError::Unavailable(message)
                if message.contains("WebKitGTK UI thread")
        ));
    }

    #[test]
    fn completion_wait_guard_allows_a_worker_thread() {
        let caller_thread = thread::current().id();
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            tx.send(thread::current().id()).unwrap();
        })
        .join()
        .unwrap();

        assert!(completion_wait_guard(caller_thread, rx.recv().unwrap()).is_ok());
    }

    #[test]
    fn website_data_kinds_map_to_the_expected_webkit_flags() {
        let types = website_data_types(ClearDataKinds {
            cookies: true,
            cache: true,
            storage: true,
        });

        assert!(types.contains(webkit2gtk::WebsiteDataTypes::COOKIES));
        assert!(types.contains(webkit2gtk::WebsiteDataTypes::MEMORY_CACHE));
        assert!(types.contains(webkit2gtk::WebsiteDataTypes::DISK_CACHE));
        assert!(types.contains(webkit2gtk::WebsiteDataTypes::SESSION_STORAGE));
        assert!(types.contains(webkit2gtk::WebsiteDataTypes::LOCAL_STORAGE));
        assert!(types.contains(webkit2gtk::WebsiteDataTypes::INDEXEDDB_DATABASES));
    }

    #[test]
    fn image_surface_encodes_as_png() {
        let image = ImageSurface::create(Format::ARgb32, 1, 1).unwrap();
        let png = surface_to_png(image.as_ref().clone()).unwrap();

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
