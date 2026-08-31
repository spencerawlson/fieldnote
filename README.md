# Fieldnote

**Turn the work you actually did into documentation that holds up.**

Fieldnote is a work documentation platform. You write rough notes and drop in
screenshots; it structures the work, explains the technology behind each step,
links your evidence to the actions it proves, finds the gaps, and generates
reports, presentations, speaker notes and the questions you are likely to be
asked — all from one project record.

It is not an AI text formatter. The point is elaboration: the system explains
what you did, how the technology works, why the step mattered, what went wrong
and what the result demonstrates. It does that without inventing anything you
did not do.

```
YOUR NOTES ─┐
SCREENSHOTS ─┼─▶ AI understanding ─▶ PROJECT KNOWLEDGE ─┬─▶ Report (PDF · DOCX · HTML · MD)
COMMANDS ────┤     (provenance +        (source of      ├─▶ Presentation (PPTX · PDF)
LOGS ────────┘      confidence)          truth)         ├─▶ Speaker notes
                                                        └─▶ Q&A preparation
```

---

## Contents

- [What makes it different](#what-makes-it-different)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Desktop app](#desktop-app)
- [Configuration](#configuration)
- [How you use it](#how-you-use-it)
- [Running the tests](#running-the-tests)
- [Documentation](#documentation)
- [Project status](#project-status)
- [Licence](#licence)

---

## What makes it different

**Every sentence carries its provenance.** Nothing generated is presented as
undifferentiated prose. Each statement is labelled:

| Label | Meaning |
| --- | --- |
| `USER_FACT` | Restates something you wrote. Treated as fact. |
| `EVIDENCE` | Read out of an artifact you uploaded. |
| `AI_EXPLANATION` | General technical background, not a claim about your project. |
| `AI_INFERENCE` | A conclusion the model drew. It may be wrong. |
| `AI_RECOMMENDATION` | Advice for the future — never history. |

This runs all the way through: a paragraph in the exported PDF traces back to
the claim it came from, which traces back to your sentence or your screenshot.
A root cause the model inferred is rendered as an inference callout, not as a
statement of what happened.

**It will not claim something worked without evidence.** If you record a fix but
the project holds no capture showing it working, the report says the validation
is unevidenced rather than quietly asserting success.

**It tells you what is missing.** A completeness estimate and a gap analysis
name the specific step with no evidence, the resolved problem with no diagnosis,
the claim nothing supports.

**Your corrections win.** Every AI output is editable, and an edited statement
survives regeneration. The AI's reading of a screenshot is a proposal you
confirm, correct or reject.

**What you preview is what you get.** Reports and decks render live in the
workspace, in the theme you picked — the same tokens the exporter uses, so the
preview is a fair representation rather than a rough guide.

**It works offline.** With no API key configured the whole pipeline still runs
end to end — intake, evidence linking, elaboration, report, deck, Q&A, export —
using a deterministic local provider. The writing is generic, but nothing is
broken, and the test-suite runs without spending a token.

---

## Requirements

- **Node.js 24 or newer.** The backend uses `node:sqlite` and runs TypeScript
  natively, so there is no build step for the server.
- An **OpenAI API key** for real elaboration (optional — see offline mode above).
- For the desktop build: **Rust 1.77+** and the platform toolchain
  ([see below](#desktop-app)).

No database server, no Redis, no Docker.

---

## Quick start

```bash
git clone <this repository>
cd fieldnote
npm install

cp .env.example .env
# Add your key:  OPENAI_API_KEY=sk-...
# Generate a secret:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

npm run build          # builds the web interface
npm start              # http://localhost:4000
```

The first account you register owns the instance.

For interface development, run the API and the Vite dev server side by side:

```bash
npm run dev            # API on :4000, with reload
npm run dev:web        # UI on :5173, proxying /api to :4000
```

---

## Desktop app

The desktop build is the same application, packaged: a native window, the Node
backend bundled as a sidecar, and an installer.

```bash
npm run desktop:dev     # run it as a desktop app
npm run desktop:build   # produce an installer
```

Output lands in `desktop/target/release/bundle/` — `.msi` and `.exe` on Windows,
`.deb` and `.AppImage` on Linux, `.dmg` on macOS.

**Toolchain.** Windows needs the Microsoft C++ build tools and WebView2 (present
on Windows 11 by default); Linux needs `libwebkit2gtk-4.1-dev` and
`build-essential`; macOS needs Xcode command line tools. `npm run desktop:build`
runs `scripts/prepare-desktop.mjs` first, which builds the interface and copies
the running Node runtime in as the sidecar.

**Where your data lives.** The desktop app keeps the database, uploads and
exports under your user profile, never inside the installation directory:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\app.fieldnote.desktop` |
| macOS | `~/Library/Application Support/app.fieldnote.desktop` |
| Linux | `~/.local/share/app.fieldnote.desktop` |

Your API key is stored in `settings.json` in the config directory alongside it,
and is passed to the backend as an environment variable — it is never sent to
the webview or written into a project.

---

## Configuration

Everything is environment-driven; see [`.env.example`](.env.example) for the
annotated list. The settings you are most likely to change:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Enables real elaboration. Without it, offline mode. |
| `AI_PROVIDER` | `openai` | `openai`, `anthropic` or `mock`. |
| `AI_MODEL_REASONING` | `gpt-5` | Reports, decks, knowledge building. |
| `AI_MODEL_FAST` | `gpt-5-mini` | Short structured calls. |
| `AI_MODEL_VISION` | `gpt-5-mini` | Screenshot analysis and transcription. |
| `OCR_DRIVER` | `vision` | `vision`, `tesseract` (needs `tesseract.js`), or `none`. |
| `DATABASE_PATH` | `./storage/fieldnote.db` | SQLite file. |
| `STORAGE_PATH` | `./storage/uploads` | Uploaded files. Never served statically. |
| `MAX_UPLOAD_BYTES` | 25 MB | Per-file upload ceiling. |
| `AI_USER_MONTHLY_CENTS` | `0` (off) | Soft monthly spend cap per user. |

If the selected provider has no key, Fieldnote falls back to the offline
provider and says so in the interface rather than failing to start.

---

## How you use it

**1 — Paste what you did.** One action per line, the way you would tell a
colleague:

```
Installed Windows Server.
Configured static IP.
Installed AD DS.
Created domain lab.local.
Tried joining Windows 11 client.
Domain join failed.
Changed client DNS to domain controller.
Domain join succeeded.
```

Fieldnote proposes steps and problems — including spotting that the failure and
the later success are the same episode. Nothing is written until you accept it,
and your original sentence is preserved verbatim on every step.

**2 — Drop in your screenshots.** Each one is analysed and transcribed, its text
becomes searchable, secrets in it are detected and redacted, and it is matched to
the step or problem it supports with a role: *symptom*, *resolution*,
*validation*, *before*, *after*.

**3 — Let it elaborate.** For each step, the AI fills only the slots that carry
real information — what the technology is, why the step mattered, what it
depended on, what to watch for — and labels every one.

**4 — Read what it says is missing.** Then generate the report and the deck, get
your speaker notes, and rehearse against the questions it predicts. Change a
fact later and regenerate; you never maintain two copies.

**5 — Choose how it looks, then save it.** Reports save as **Word (.docx)** or
**PDF**; presentations save as **PowerPoint (.pptx)**; HTML and Markdown are
there too. Six visual themes — Slate, Academic, Midnight, Forest, Ember,
Technical — control typography, accent colour and cover treatment. Switching
theme is instant and needs no regeneration, because a theme changes only how
the document looks, never what it says.

Every report opens on a proper cover page: a document-type label derived from
the template, the title block over an accent rule, prepared-by and prepared-for
lines, and a document-control row carrying version, date, status and
classification. The same information appears in the DOCX, the PDF and the HTML,
in each format's own idiom.

---

## Running the tests

```bash
npm test
```

58 tests across four suites, all against the deterministic provider — no API
key, no network:

- `acceptance.test.ts` — the full scenario end to end: notes in, structured
  project, evidence analysed and linked, problem explained, report and deck and
  notes and Q&A generated, every format exported, a human correction surviving
  regeneration.
- `security.test.ts` — authorization boundaries, CSRF, session forgery, upload
  type confusion, path traversal, prompt injection containment, secret
  redaction.
- `units.test.ts` — knowledge-model invariants, template behaviour, export
  validation, provider abstraction.
- `themes.test.ts` — that a theme actually reaches the exported bytes in DOCX,
  PDF, HTML and PPTX, not just the preview.

---

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System shape and the decisions behind it |
| [AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) | The AI pipeline, prompts, provenance and cost control |
| [DATABASE.md](docs/DATABASE.md) | Data model, the claims table, PostgreSQL migration path |
| [SECURITY.md](docs/SECURITY.md) | Threat model and controls |
| [API.md](docs/API.md) | HTTP endpoints |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Running it in production, and packaging the desktop app |
| [TESTING.md](docs/TESTING.md) | Test strategy and how to add to it |
| [CONTRIBUTING.md](docs/CONTRIBUTING.md) | Working on the codebase |

---

## Project status

Working end to end and tested, at version 0.1.0. What is deliberately not built
yet is listed in [ARCHITECTURE.md](docs/ARCHITECTURE.md#what-is-not-built-yet) —
including semantic search (the schema and interfaces are in place, embeddings
are not generated), diagram generation, and voice notes.

## Licence

MIT — see [LICENSE](LICENSE).
