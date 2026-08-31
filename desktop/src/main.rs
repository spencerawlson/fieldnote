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
                        let _ = handle.emit("fieldnote://failed", error.to_string());
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
