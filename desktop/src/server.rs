//! Lifecycle management for the bundled Node backend.
//!
//! The desktop build ships the same server the web build runs: a Node sidecar
//! plus the application source as a bundled resource. The Rust shell owns its
//! lifetime — picking a free port, injecting per-machine paths and secrets,
//! waiting for it to become healthy, and making sure it dies with the window.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rand::Rng;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Detach the child from the parent console so no terminal flashes on launch.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct ServerHandle {
    child: Arc<Mutex<Option<Child>>>,
}

impl ServerHandle {
    /// Terminates the backend. Safe to call more than once.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Debug)]
pub enum StartError {
    NoPort,
    MissingResource(PathBuf),
    Spawn(String),
    Timeout(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NoPort => write!(f, "Could not find a free local port to run on."),
            StartError::MissingResource(path) => write!(
                f,
                "The bundled application files are missing or incomplete (expected {}).\n\nReinstall Fieldnote.",
                path.display()
            ),
            StartError::Spawn(message) => write!(f, "Could not start the Fieldnote backend: {message}"),
            StartError::Timeout(log) => write!(
                f,
                "The Fieldnote backend did not become ready in time.\n\nLast output:\n{log}"
            ),
        }
    }
}

/// Binds port 0 to let the OS allocate, then releases it. A race is possible in
/// principle; in practice the child binds within milliseconds, and a failure is
/// surfaced rather than retried silently.
fn free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

fn random_secret() -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    (0..64)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

pub struct StartOptions {
    /// Directory holding the bundled `server/` and `node_modules/` resources.
    pub resource_dir: PathBuf,
    /// Path to the bundled Node runtime.
    pub node_binary: PathBuf,
    /// Per-user writable directory for the database, uploads and exports.
    pub data_dir: PathBuf,
    /// Persisted session secret, so sign-in survives a restart.
    pub session_secret: Option<String>,
    /// Provider credentials, read from the desktop settings file.
    pub env: Vec<(String, String)>,
}

pub fn start(options: StartOptions) -> Result<(ServerHandle, String), StartError> {
    let entry = options.resource_dir.join("server").join("src").join("index.ts");
    if !entry.exists() {
        return Err(StartError::MissingResource(entry));
    }
    if !options.node_binary.exists() {
        return Err(StartError::MissingResource(options.node_binary));
    }

    let port = free_port().ok_or(StartError::NoPort)?;
    let url = format!("http://127.0.0.1:{port}");
    let secret = options.session_secret.unwrap_or_else(random_secret);

    std::fs::create_dir_all(&options.data_dir).ok();

    let mut command = Command::new(&options.node_binary);
    command
        .arg("--disable-warning=ExperimentalWarning")
        .arg(&entry)
        .current_dir(&options.resource_dir)
        .env("NODE_ENV", "production")
        .env("PORT", port.to_string())
        .env("APP_URL", &url)
        .env("HOST", "127.0.0.1")
        .env("SESSION_SECRET", secret)
        // Everything the user creates lives under their profile, never inside
        // the installation directory (which is read-only for standard users).
        .env("DATABASE_PATH", options.data_dir.join("fieldnote.db"))
        .env("STORAGE_PATH", options.data_dir.join("uploads"))
        .env("ALLOWED_ORIGINS", &url)
        .env("LOG_LEVEL", "info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in options.env {
        command.env(key, value);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|e| StartError::Spawn(e.to_string()))?;

    // Drain the child's output into a bounded buffer. Without this the pipe
    // fills and the server blocks on its own logging; the buffer also gives us
    // something useful to show if startup fails.
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let log = Arc::clone(&log);
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut buffer) = log.lock() {
                    if buffer.len() >= 200 {
                        buffer.remove(0);
                    }
                    buffer.push(line);
                }
            }
        });
    }

    let handle = ServerHandle {
        child: Arc::new(Mutex::new(Some(child))),
    };

    wait_until_healthy(&url, Duration::from_secs(45), &log)?;
    Ok((handle, url))
}

/// Polls the health endpoint over a raw TCP request — a full HTTP client would
/// be a heavy dependency for one request made once per launch.
fn wait_until_healthy(
    url: &str,
    timeout: Duration,
    log: &Arc<Mutex<Vec<String>>>,
) -> Result<(), StartError> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let address = url.trim_start_matches("http://").to_string();
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(&address) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let request = format!("GET /api/health HTTP/1.0\r\nHost: {address}\r\n\r\n");
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut response = String::new();
                if stream.read_to_string(&mut response).is_ok() && response.contains("\"status\"") {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    let tail = log
        .lock()
        .map(|buffer| buffer.join("\n"))
        .unwrap_or_else(|_| String::from("(no output captured)"));
    Err(StartError::Timeout(tail))
}

/// Reads persisted desktop settings (API key, provider, models).
pub fn load_settings(config_dir: &Path) -> serde_json::Value {
    let path = config_dir.join("settings.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn save_settings(config_dir: &Path, settings: &serde_json::Value) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_dir.join("settings.json");
    std::fs::write(path, serde_json::to_string_pretty(settings)?)
}

/// Turns stored settings into the environment the backend expects.
pub fn settings_to_env(settings: &serde_json::Value) -> Vec<(String, String)> {
    let mut env = Vec::new();
    let mut copy = |json_key: &str, env_key: &str| {
        if let Some(value) = settings.get(json_key).and_then(|v| v.as_str()) {
            if !value.trim().is_empty() {
                env.push((env_key.to_string(), value.trim().to_string()));
            }
        }
    };
    copy("provider", "AI_PROVIDER");
    copy("openaiApiKey", "OPENAI_API_KEY");
    copy("anthropicApiKey", "ANTHROPIC_API_KEY");
    copy("openaiBaseUrl", "OPENAI_BASE_URL");
    copy("modelReasoning", "AI_MODEL_REASONING");
    copy("modelFast", "AI_MODEL_FAST");
    copy("modelVision", "AI_MODEL_VISION");
    copy("ocrDriver", "OCR_DRIVER");
    env
}
