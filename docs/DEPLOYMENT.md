# Deployment

Two ways to run Fieldnote: as a server, or as an installed desktop app. Both run
the same backend.

---

## Server

### Requirements

- Node.js 24+ (`node:sqlite`, native TypeScript execution)
- A writable directory for the database, uploads and exports
- A reverse proxy terminating TLS

No database server, no Redis, no container required.

### Install

```bash
git clone <repository> /opt/fieldnote
cd /opt/fieldnote
npm ci --omit=dev --workspace=server
npm ci                       # dev deps needed once, to build the interface
npm run build
```

### Configure

```bash
cp .env.example .env
```

Set at minimum:

```ini
NODE_ENV=production
PORT=4000
APP_URL=https://fieldnote.example.com
ALLOWED_ORIGINS=https://fieldnote.example.com

SESSION_SECRET=<48 random bytes, base64url>
DATABASE_PATH=/var/lib/fieldnote/fieldnote.db
STORAGE_PATH=/var/lib/fieldnote/uploads

OPENAI_API_KEY=sk-...
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`assertProductionConfig()` refuses to start if the secret is missing or short,
if the configured provider has no key, or if the database is in memory. Failing
to boot beats running insecurely.

### Run

```bash
npm run migrate    # optional; startup migrates too
npm start
```

#### systemd

```ini
[Unit]
Description=Fieldnote
After=network.target

[Service]
Type=simple
User=fieldnote
WorkingDirectory=/opt/fieldnote
EnvironmentFile=/opt/fieldnote/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/src/index.ts
Restart=on-failure
RestartSec=5

# The process needs nothing outside its own data directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/fieldnote

[Install]
WantedBy=multi-user.target
```

```bash
sudo install -d -o fieldnote -g fieldnote -m 0750 /var/lib/fieldnote
sudo systemctl enable --now fieldnote
```

### Reverse proxy

```nginx
server {
    listen 443 ssl http2;
    server_name fieldnote.example.com;

    ssl_certificate     /etc/letsencrypt/live/fieldnote.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fieldnote.example.com/privkey.pem;

    # Uploads are capped in the app; keep the proxy consistent with MAX_UPLOAD_BYTES.
    client_max_body_size 30M;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Job progress is server-sent events: no buffering, long read timeout.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

`trustProxy` is enabled, so `X-Forwarded-For` drives rate limiting and the
audit log.

### Backup

Everything lives in two places:

```bash
sqlite3 /var/lib/fieldnote/fieldnote.db ".backup '/backup/fieldnote-$(date +%F).db'"
tar czf /backup/uploads-$(date +%F).tar.gz -C /var/lib/fieldnote uploads
```

Use `.backup`, not `cp` — WAL mode means a plain copy can catch a torn state.

### Upgrading

```bash
git pull && npm ci && npm run build
sudo systemctl restart fieldnote
```

Migrations run at startup, each in its own transaction. Back up first.

### Sizing

Comfortable on 1 vCPU / 1 GB. The work is I/O-bound on AI calls; `JOB_CONCURRENCY`
(default 2) governs parallel model calls. Uploads dominate disk: budget roughly
2 MB per screenshot.

---

## Desktop application

The desktop build packages the same backend as a sidecar behind a native window.

### Build prerequisites

| Platform | Needs |
| --- | --- |
| Windows | Rust (MSVC toolchain recommended), Microsoft C++ Build Tools, WebView2 (present on Windows 11) |
| macOS | Rust, Xcode command line tools |
| Linux | Rust, `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev` |

> **On Windows with the GNU toolchain:** rustup's `x86_64-pc-windows-gnu` target
> links against the **MinGW64** (msvcrt) runtime. If MSYS2's UCRT64 `gcc` is
> first on `PATH`, linking fails with `ld returned 116`. Either put
> `C:\msys64\mingw64\bin` ahead of it, or install the MSVC toolchain, which is
> what Tauri officially supports:
> ```
> rustup toolchain install stable-x86_64-pc-windows-msvc
> rustup default stable-x86_64-pc-windows-msvc
> ```

### Build

```bash
npm run desktop:build
```

`scripts/prepare-desktop.mjs` runs first and does three things, in this order:

1. **Builds the interface** if `web/dist` is stale. This must happen before
   bundling starts, because Tauri snapshots the resource file list up front —
   rebuilding afterwards leaves the manifest pointing at hashed asset names that
   no longer exist, and `makensis` fails with "no files found".
2. **Prunes the runtime tree** (`scripts/prune-runtime.mjs`). The workspace
   `node_modules` holds Vite, esbuild, TypeScript and React, none of which the
   backend needs at runtime. Walking the server's declared dependencies
   transitively yields ~137 packages and roughly halves what is compressed into
   the installer.
3. **Copies the running Node runtime** into `desktop/binaries/` as a Tauri
   sidecar, named for the target triple. Node is bundled rather than assumed —
   an installable app cannot require a matching Node on the user's PATH. Both
   the rustc host triple and the MSVC triple are provided (the second as a hard
   link), because cargo looks for the former while the Windows bundler asks for
   the latter.

Installers land in `desktop/target/release/bundle/`:

| Platform | Artifacts |
| --- | --- |
| Windows | `nsis/*.exe`, `msi/*.msi` |
| macOS | `dmg/*.dmg`, `macos/*.app` |
| Linux | `deb/*.deb`, `appimage/*.AppImage` |

Expect roughly 190 MB installed: the Node runtime is ~90 MB and the pruned
dependency tree another ~93 MB. The compression step is the slow part of the
build — several minutes on a modest machine.

### How the shell behaves

1. Opens a window on a splash page immediately.
2. Generates and persists a per-installation session secret **before** starting
   the backend, so sign-in survives a restart.
3. Binds the backend to `127.0.0.1` on an OS-allocated free port.
4. Polls `/api/health` for up to 45 seconds, then navigates the webview to it.
5. On failure, shows the error and the tail of the backend log on the splash
   page rather than a blank window.
6. Kills the backend when the window is destroyed, so no orphaned Node process
   survives.

### Where user data lives

| Platform | Data | Config |
| --- | --- | --- |
| Windows | `%APPDATA%\app.fieldnote.desktop` | same |
| macOS | `~/Library/Application Support/app.fieldnote.desktop` | `~/Library/Preferences/...` |
| Linux | `~/.local/share/app.fieldnote.desktop` | `~/.config/app.fieldnote.desktop` |

Never inside the installation directory, which is read-only for standard users.

### API key in the desktop build

Stored in `settings.json` in the config directory and passed to the backend as
an environment variable. It is never sent to the webview; `get_settings` returns
masked values. Changing it takes effect on the next launch, because the backend
reads provider configuration once at startup.

### Code signing

Unsigned builds trigger SmartScreen on Windows and Gatekeeper on macOS. For
distribution, sign with:

```jsonc
// desktop/tauri.conf.json
"bundle": {
  "windows": { "certificateThumbprint": "…", "digestAlgorithm": "sha256",
               "timestampUrl": "http://timestamp.digicert.com" },
  "macOS":   { "signingIdentity": "Developer ID Application: …",
               "entitlements": "entitlements.plist" }
}
```

---

## Observability

`GET /api/health` — liveness plus AI provider status.
`GET /api/metrics` — admin only; request counters and latency percentiles.
`GET /api/projects/:id/usage` — AI tokens and estimated cost per project.

Logs are JSON on stdout with field-level redaction; secrets and project content
are never logged. With systemd, `journalctl -u fieldnote -f`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Refuses to start in production | `assertProductionConfig()` — read the message; it lists every problem |
| Banner says "offline mode" | No API key for the configured provider. Everything works; elaboration is generic. |
| Jobs stay queued | `JOB_WORKER_ENABLED=false`, or the worker crashed. Stale `running` jobs are requeued at startup. |
| SSE progress never updates | A proxy is buffering. Set `proxy_buffering off`. |
| Uploads fail at ~1 MB | The proxy's body limit, not the app's. Raise `client_max_body_size`. |
| Thumbnails missing | `sharp` is an optional dependency; uploads still succeed without it. |
| Desktop app shows a startup error | The splash page prints the backend log tail — usually a missing bundled resource. |
