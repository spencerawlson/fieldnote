# Security

## What this application handles

Projects contain screenshots of real infrastructure: internal hostnames, IP
plans, configuration, error messages, occasionally a credential someone did not
notice was on screen. The threat model starts from the assumption that
**uploaded content is hostile and the AI's output is untrusted**.

## Authentication

Email and password. Passwords are hashed with **scrypt** (N=16384, r=8, p=1,
64-byte key) with a per-password random salt, verified with
`timingSafeEqual`. A login attempt for an unknown account still performs a hash
against a placeholder, so response timing does not distinguish "no such user"
from "wrong password" — and both return the same message.

Sessions are **server-side rows**, not self-contained tokens. The cookie carries
`sessionId.hmac`:

- the HMAC (keyed on `SESSION_SECRET`) means a guessed or tampered id is
  rejected without a database round-trip;
- server-side state means logout and revocation are immediate, which a JWT
  cannot give you.

Cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production. Expired
sessions are purged at startup.

Registration and login are rate limited (10 and 20 attempts per 10 minutes).

## Authorization

Every project route resolves membership through `authorizeProject()`, which
returns the project *and* the caller's role, or throws. Roles rank
`viewer < editor < owner`.

**Non-members receive 404, not 403.** A 403 confirms that a project exists; the
API does not confirm the existence of other people's projects.

Ownership of a nested resource is re-checked, not inferred from the URL: fetching
a step verifies `step.projectId === projectId`, so a valid id from another
project cannot be read by nesting it under a project you can access.

## CSRF

Double-submit against the server-side session token, plus an `Origin` check
against `ALLOWED_ORIGINS`. Cookies are already `SameSite=Lax`; this is defence
in depth. Safe methods are exempt; unauthenticated requests are rejected by the
route itself.

## File uploads

The declared `Content-Type` is a claim by the client, not a fact.

1. **Magic-byte validation.** Every upload is checked against its real signature.
   A file declared `image/png` whose bytes say otherwise is rejected with 415.
2. **Zip-based formats** (docx/pptx/xlsx) are disambiguated only among types we
   accept; an unrecognised zip is refused.
3. **SVG is rejected outright.** It is a scriptable document that browsers
   render, and no amount of sanitising makes it a safe image format here.
4. **Plain text** must actually decode as text without control bytes.
5. **Size limits** are enforced at the multipart layer and again after buffering.
6. **Opaque storage keys.** User-supplied filenames never reach the filesystem.
   `LocalDriver.path()` refuses any key that is not
   `[A-Za-z0-9/_.-]+`, contains `..`, or resolves outside the storage root.
7. **The uploads directory is never served statically.** Bytes come back only
   through `/api/projects/:id/files/:fileId`, which re-checks membership and
   sends `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` and
   `Content-Security-Policy: default-src 'none'; sandbox`.
8. `storage_key` is stripped from every API response.

*Not implemented:* malware scanning. The `files.scan_state` column and the
upload hook exist; no scanner is wired. Stated rather than implied.

## Prompt injection

Uploaded documents, screenshots and OCR text are untrusted data. A terminal
screenshot can legitimately contain "ignore previous instructions".

- **System instructions come from constants in this codebase only.** Project
  content never reaches the system slot.
- **Untrusted content is fenced with a random per-call nonce.** Content cannot
  forge the closing delimiter because it does not know the nonce.
- **Delimiter-imitating text is neutralised before fencing**, including
  zero-width characters used to smuggle a forged tag past a literal comparison.
- **`SAFETY_PREAMBLE`** tells the model that fenced content is data, that a
  request inside it to change the task is an observation about the content, and
  that missing information is reported as missing.
- **`detectInjection()`** flags suspicious content so the *user* is warned their
  evidence contains instruction-like text.

Model output is treated as untrusted in the other direction too: cited evidence
ids are validated against real links, proposed evidence links are filtered
against supplied ids, and slide references to non-existent evidence are dropped.

## Secret detection and privacy

Extracted text is scanned on every upload for AWS keys, OpenAI and Anthropic
keys, GitHub and Slack tokens, Google API keys, JWTs, private key blocks,
connection strings with embedded credentials, and password assignments.

When a secret is found:

- a **redacted copy** is stored, and the redacted version is what reaches the AI
  and every export;
- the evidence is flagged `sensitive`;
- a `secret_findings` row is created and surfaced in the interface.

Masking shows enough to recognise a key (`AKIAIO••••••••MPLE`), never enough to
use it. RFC1918 addresses and `.local`/`.internal` hostnames are detected
separately as a privacy hint rather than as secrets.

## Input validation and output encoding

Every request body is validated with zod. Free text has C0 control characters
stripped — they either corrupt a PDF or vanish mid-sentence in a DOCX. Failures
return 422 naming the offending field.

All SQL is parameterised; no query is built by string concatenation.

The interface is React (escaping by default) and the CSP forbids inline script,
external script, and framing.

## Transport and headers

Helmet sets CSP (`default-src 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, and
`Cross-Origin-Resource-Policy: same-origin`. TLS is expected to terminate at a
reverse proxy in production — see `DEPLOYMENT.md`.

## Logging

`lib/logger.ts` redacts by field name (`password`, `token`, `secret`, `apiKey`,
`authorization`, `cookie`, `ocrText`, `userDescription`, `notes`, `prompt`) and
truncates long strings. Project content is deliberately absent from logs, and a
test asserts the audit log contains no secret material.

The audit log records who did what to which entity, with the IP — not the
content of what they wrote.

## Production configuration

`assertProductionConfig()` refuses to start when `NODE_ENV=production` and:

- `SESSION_SECRET` is missing or under 32 characters;
- the configured AI provider has no API key;
- `DATABASE_PATH` is `:memory:`.

Failing to boot beats running insecurely.

## Desktop specifics

The desktop shell binds the backend to `127.0.0.1` on an OS-allocated port with
a per-installation session secret stored in the user's config directory. The
API key lives in `settings.json` there and is passed to the backend as an
environment variable — it is never sent to the webview. `get_settings` returns
masked values only. User data lives under the user profile, never in the
installation directory.

## What is tested

`server/test/security.test.ts` — 19 tests covering unauthenticated access, the
404-not-403 boundary, the viewer/editor boundary, CSRF, forged cookies,
validation errors, type-confusion uploads, SVG rejection, file-serving headers,
error-message leakage, injection containment, secret detection and redaction,
control-character stripping, path traversal, password hashing, login timing
uniformity, and audit-log cleanliness.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
