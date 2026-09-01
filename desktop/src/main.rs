// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Fieldnote desktop shell.
//!
//! The desktop build is the web application, bundled: a Node backend, the
//! compiled interface, and a native window that owns their lifetime. The shell
//! deliberately holds no product logic of its own — it starts the backend on a
//! free port, waits for it to be healthy, points the webview at it, and keeps
//! per-user data and credentials out of the installation directory.

mod server;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::webview::DownloadEvent;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

struct AppState {
    server: Mutex<Option<server::ServerHandle>>,
    url: Mutex<Option<String>>,
    config_dir: PathBuf,
}

/// Reports the backend URL to the splash screen.
#[tauri::command]
fn server_url(state: tauri::State<'_, AppState>) -> Option<String> {
    state.url.lock().ok().and_then(|url| url.clone())
}

/// Returns stored settings with the API keys masked — the real values never
/// travel back to a webview.
#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let settings = server::load_settings(&state.config_dir);
    let mask = |value: Option<&str>| -> serde_json::Value {
        match value {
            Some(key) if key.len() > 8 => {
                serde_json::Value::String(format!("{}…{}", &key[..4], &key[key.len() - 4..]))
            }
            Some(_) => serde_json::Value::String("configured".into()),
            None => serde_json::Value::Null,
        }
    };
    serde_json::json!({
        "provider": settings.get("provider").and_then(|v| v.as_str()).unwrap_or("openai"),
        "openaiApiKey": mask(settings.get("openaiApiKey").and_then(|v| v.as_str())),
        "anthropicApiKey": mask(settings.get("anthropicApiKey").and_then(|v| v.as_str())),
        "modelReasoning": settings.get("modelReasoning"),
        "modelFast": settings.get("modelFast"),
        "modelVision": settings.get("modelVision"),
    })
}

/// Persists settings. Takes effect on the next launch, because the backend
/// reads its provider configuration once at startup.
#[tauri::command]
fn save_settings(
    state: tauri::State<'_, AppState>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let mut current = server::load_settings(&state.config_dir);
    if let (Some(existing), Some(incoming)) = (current.as_object_mut(), settings.as_object()) {
        for (key, value) in incoming {
            // An empty string clears a key; a masked placeholder leaves it alone.
            let text = value.as_str().unwrap_or("");
            if text.contains('…') {
                continue;
            }
            existing.insert(key.clone(), value.clone());
        }
    }
    server::save_settings(&state.config_dir, &current).map_err(|e| e.to_string())
}

#[tauri::command]
fn data_directory(app: tauri::AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let resource_dir = app.path().resource_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            std::fs::create_dir_all(&config_dir).ok();

            app.manage(AppState {
                server: Mutex::new(None),
                url: Mutex::new(None),
                config_dir: config_dir.clone(),
            });

            // The splash window appears immediately; the backend starts behind
            // it. A cold start has to load Node and run migrations, which is a
            // second or two — long enough that a blank screen would look broken.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Fieldnote")
                .inner_size(1360.0, 900.0)
                .min_inner_size(940.0, 640.0)
                .center()
                .resizable(true)
                // Exports are delivered as ordinary downloads from the local
                // backend. Left to itself the webview writes them into the
                // Downloads folder without a prompt, without a progress
                // indication and without telling the page anything — so the
                // button appears to do nothing at all and the file is only
                // discovered later, if ever. Taking the event lets the app say
                // where the file went, which is the whole of what was missing.
                .on_download(|webview, event| match event {
                    DownloadEvent::Requested { url, destination } => {
                        let name = suggested_file_name(&url);
                        let target = downloads_dir().join(&name);
                        *destination = unique_path(target);
                        let _ = webview.emit("export-download-started", name);
                        true
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        let _ = webview.emit(
                            "export-download-finished",
                            DownloadFinished {
                                success,
                                path: path.as_ref().map(|p| p.display().to_string()),
                                name: suggested_file_name(&url),
                            },
                        );
                        true
                    }
                    _ => true,
                })
                .build()?;

            std::thread::spawn(move || {
                let state = handle.state::<AppState>();
                let mut settings = server::load_settings(&state.config_dir);

                // The session secret is generated and persisted *before* the
                // backend starts, so the value the server signs cookies with is
                // the same one it will use after a restart. Generating it after
                // startup would silently sign everyone out on second launch.
                let session_secret = match settings.get("sessionSecret").and_then(|v| v.as_str()) {
                    Some(existing) => existing.to_string(),
                    None => {
                        let generated = random_secret();
                        if let Some(object) = settings.as_object_mut() {
                            object.insert(
                                "sessionSecret".into(),
                                serde_json::Value::String(generated.clone()),
                            );
                        }
                        let _ = server::save_settings(&state.config_dir, &settings);
                        generated
                    }
                };

                let options = server::StartOptions {
                    resource_dir: resource_dir.clone(),
                    node_binary: node_binary_path(&resource_dir),
                    data_dir: data_dir.clone(),
                    session_secret: Some(session_secret),
                    env: server::settings_to_env(&settings),
                };

                match server::start(options) {
                    Ok((server_handle, url)) => {
                        *state.url.lock().unwrap() = Some(url.clone());
                        *state.server.lock().unwrap() = Some(server_handle);

                        let _ = handle.emit("fieldnote://ready", url.clone());
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.navigate(url.parse().expect("server url is valid"));
                        }
                    }
                    Err(error) => {
                        // A failure that only appears on the splash window is
                        // almost impossible to support remotely. Write it where
                        // it can be read, and to stderr for a console launch.
                        let message = error.to_string();
                        eprintln!("Fieldnote failed to start: {message}");
                        let log = state.config_dir.join("startup-error.log");
                        let _ = std::fs::write(
                            &log,
                            format!(
                                "{}

resource_dir: {}
data_dir: {}
node: {}
",
                                message,
                                resource_dir.display(),
                                data_dir.display(),
                                node_binary_path(&resource_dir).display(),
                            ),
                        );
                        let _ = handle.emit("fieldnote://failed", message);
                    }
                }
            });

            let _ = window;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            server_url,
            get_settings,
            save_settings,
            data_directory
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Killing the backend on window destruction is what stops an
                // orphaned Node process outliving the app.
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if let Ok(guard) = state.server.lock() {
                        if let Some(server) = guard.as_ref() {
                            server.shutdown();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start Fieldnote");
}

/// The sidecar is bundled under the platform triple Tauri appends.
fn node_binary_path(resource_dir: &std::path::Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled = resource_dir.join("binaries").join(name);
    if bundled.exists() {
        return bundled;
    }
    // Tauri places externalBin next to the executable rather than in resources.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(name);
            if sidecar.exists() {
                return sidecar;
            }
        }
    }
    // Development fallback: whatever Node is on PATH.
    PathBuf::from(name)
}

/// Per-installation session secret, generated once and stored in the user's
/// config directory.
fn random_secret() -> String {
    use rand::Rng;
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    (0..64)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

/// Payload for the completion event the interface listens for.
#[derive(Clone, serde::Serialize)]
struct DownloadFinished {
    success: bool,
    path: Option<String>,
    name: String,
}

/// The user's Downloads folder, falling back to the home directory.
///
/// `dirs` is not a dependency and this is the only place a well-known folder is
/// needed, so the profile-relative path is good enough: on Windows the shell
/// only relocates Downloads for users who have deliberately moved it, and the
/// fallback covers that case by writing somewhere that certainly exists.
fn downloads_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let candidate = PathBuf::from(&home).join("Downloads");
        if candidate.is_dir() {
            return candidate;
        }
        return PathBuf::from(home);
    }
    std::env::temp_dir()
}

/// Recovers the filename the backend intends from the download URL.
///
/// The real name lives in Content-Disposition, which this event does not carry,
/// so the export route also accepts it as a trailing path segment
/// (`…/exports/<id>/download/<name>`) purely so that it survives to here. A URL
/// without that segment falls back to the export id, which is at least unique.
fn suggested_file_name(url: &tauri::Url) -> String {
    let segments: Vec<String> = url
        .path_segments()
        .map(|parts| parts.map(percent_decode).collect())
        .unwrap_or_default();

    let mut iter = segments.iter().rev();
    if let Some(last) = iter.next() {
        if !last.is_empty() && last != "download" {
            return sanitise_file_name(last);
        }
    }
    let id = segments
        .iter()
        .rev()
        .find(|part| !part.is_empty() && *part != "download")
        .cloned()
        .unwrap_or_else(|| "export".to_string());
    sanitise_file_name(&id)
}

fn percent_decode(part: &str) -> String {
    let bytes = part.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&part[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The name comes off a URL, so it is never allowed to steer where the file goes.
fn sanitise_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '\"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

/// Never silently overwrite a file the person already has.
fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("export").to_string();
    let extension = path.extension().and_then(|s| s.to_str()).map(|s| format!(".{s}")).unwrap_or_default();
    let parent = path.parent().map(PathBuf::from).unwrap_or_default();
    for n in 1..1000 {
        let candidate = parent.join(format!("{stem} ({n}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(path: &str) -> tauri::Url {
        tauri::Url::parse(&format!("http://127.0.0.1:7331{path}")).unwrap()
    }

    #[test]
    fn takes_the_name_from_the_trailing_segment() {
        assert_eq!(
            suggested_file_name(&url("/api/projects/p1/exports/e1/download/active-directory-lab.docx")),
            "active-directory-lab.docx"
        );
    }

    #[test]
    fn percent_decodes_the_name() {
        assert_eq!(
            suggested_file_name(&url("/api/projects/p1/exports/e1/download/my%20lab%20report.pdf")),
            "my lab report.pdf"
        );
    }

    #[test]
    fn falls_back_to_the_export_id_when_no_name_is_given() {
        assert_eq!(
            suggested_file_name(&url("/api/projects/p1/exports/exp_abc/download")),
            "exp_abc"
        );
    }

    #[test]
    fn a_name_from_a_url_cannot_escape_the_target_directory() {
        // Percent-encoded traversal must not survive into a path segment.
        let name = suggested_file_name(&url("/exports/e1/download/..%2F..%2Fevil.exe"));
        assert!(!name.contains('/'), "got {name}");
        assert!(!name.contains('\\'), "got {name}");
        assert!(!name.starts_with('.'), "got {name}");
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let dir = std::env::temp_dir().join("fieldnote-download-test");
        let _ = std::fs::create_dir_all(&dir);
        let taken = dir.join("report.pdf");
        std::fs::write(&taken, b"x").unwrap();
        let next = unique_path(taken.clone());
        assert_ne!(next, taken);
        assert_eq!(next.file_name().unwrap().to_str().unwrap(), "report (1).pdf");
        let _ = std::fs::remove_file(&taken);
    }
}
