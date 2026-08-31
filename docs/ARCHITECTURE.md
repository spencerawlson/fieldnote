# Architecture

## The shape of it

```
┌─────────────────────────────────────────────────────────────────────┐
│  React SPA (web/)                                                   │
│  Workspace tabs · provenance rendering · SSE job progress           │
└────────────────────────────┬────────────────────────────────────────┘
                             │ JSON over HTTP, session cookie + CSRF
┌────────────────────────────▼────────────────────────────────────────┐
│  Fastify (server/src/routes)                                        │
│  auth · projects · work · evidence · ai · outputs · jobs            │
├─────────────────────────────────────────────────────────────────────┤
│  Services                                                           │
│  ┌───────────────┐ ┌──────────────┐ ┌────────────┐ ┌─────────────┐  │
│  │ AI orchestr.  │ │ Files/images │ │ Export     │ │ Search      │  │
│  │ (ai/services) │ │ (files/)     │ │ (export/)  │ │ (search/)   │  │
│  └───────┬───────┘ └──────┬───────┘ └─────┬──────┘ └──────┬──────┘  │
│          │                │               │               │         │
│  ┌───────▼────────────────▼───────────────▼───────────────▼──────┐  │
│  │  Repositories (db/repositories) — the only SQL in the codebase │  │
│  └───────────────────────────┬───────────────────────────────────┘  │
├──────────────────────────────┼──────────────────────────────────────┤
│  Job worker (jobs/)          │   SQLite (node:sqlite) + FTS5        │
│  SQLite-backed queue         │   Local disk storage                 │
└──────────────────────────────┴──────────────────────────────────────┘
                             ▲
┌────────────────────────────┴────────────────────────────────────────┐
│  Tauri shell (desktop/) — optional                                  │
│  Spawns the backend as a sidecar, owns its lifetime, ships an        │
│  installer. Holds no product logic.                                  │
└─────────────────────────────────────────────────────────────────────┘
```

## The central idea: claims

The project is the source of truth. Reports and presentations are projections
over it, and they hold no facts of their own.

The unit of knowledge is a **claim** — one statement, with its origin attached:

```
claims
  subject_type   step | problem | project | evidence | test | result | command
  subject_id     what it is about
  slot           what_was_done, why_it_matters, root_cause_explanation, …
  provenance     USER_FACT | EVIDENCE | AI_EXPLANATION | AI_INFERENCE | AI_RECOMMENDATION
  confidence     high | medium | low
  text           the statement itself
  supports       [{type, id}] — the evidence or steps backing it
  edited_by_user whether a human has touched it
```

Everything downstream reads claims. The report renderer turns an
`AI_RECOMMENDATION` into a recommendation callout and a `USER_FACT` into plain
prose. The completeness score counts them. The Q&A generator cites them. This
is why "the AI must elaborate, but must not invent" is enforceable rather than
aspirational: the two kinds of sentence are different rows with different
labels, not different tones of voice.

### Regeneration and human corrections

`replaceGeneratedClaims` deletes only untouched generated claims. Anything with
`edited_by_user = 1` or `accepted = 1` is kept, and its slot is skipped in the
incoming batch. Editing a claim through the API sets that flag automatically. A
user who fixes a wrong explanation does not lose the fix the next time they
press *Regenerate* — which is the difference between an editable tool and a
slot machine.

## Decisions worth explaining

### SQLite via `node:sqlite`, not Postgres

The product is single-tenant per install and its heavy work is AI calls, not
queries. SQLite removes a whole class of deployment problems (no server, no
connection pool, no migration of credentials into a desktop app) and its FTS5
extension gives full-text search over steps, OCR text and AI explanations
without another dependency. `node:sqlite` ships with Node 24, so there is no
native module to compile — which matters directly for the desktop bundle.

The schema is written to port: `docs/DATABASE.md` lists the mechanical changes
for PostgreSQL, and all SQL is confined to `db/repositories/`.

*Trade-off:* one writer at a time. Fine for the intended scale; a team
deployment with heavy concurrent writes would want the Postgres path.

### No build step for the backend

Node 24 runs TypeScript directly (type stripping). `server/` is written in
erasable-only TypeScript — no enums, no parameter properties — enforced by
`erasableSyntaxOnly` in `tsconfig.json`. `tsc` runs for type checking only.

This is why the desktop bundle can ship source rather than a compiled artifact,
and why `npm test` runs `.ts` files with no transpile step.

### A SQLite job queue instead of Redis

Long operations (AI calls, document rendering) run in `jobs/worker.ts`, which
claims rows under a transaction. Durability, retries with backoff, progress
reporting and crash recovery, in one process and one file.

`claimNextJob` takes the row atomically, so a second worker process can be
added later without a schema change. Progress reaches the browser over SSE,
chosen over WebSockets because progress is one-directional and the browser
reconnects on its own.

*Trade-off:* polling every 500ms rather than push. Irrelevant next to a
multi-second model call.

### Prose is generated; structure is assembled

In the report generator, narrative sections (executive summary, methodology,
conclusion) are written by the model. Structural sections (step-by-step,
problems, testing, results, appendix) are assembled deterministically from the
database.

That split is why figure numbers correspond to real evidence records, why
captions are the ones you edited, and why a step cannot quietly change wording
between the workspace and the PDF.

### Templates control structure; themes control appearance

Two separate registries, deliberately:

- **`domain/templates.ts`** decides which sections exist and what each is for.
  Changing it changes what the document says, so it requires regeneration.
- **`export/themes.ts`** decides typography, accent colour, cover treatment and
  callout styling. Changing it changes nothing about the content, so switching
  theme is instant — the next export simply renders differently.

Keeping them apart is why the theme dropdown does not trigger an AI call, and
why an academic report and a technical one can be the same words in different
clothes. One theme registry serves DOCX, PDF, HTML, PPTX *and* the in-app
preview, so the four outputs cannot drift apart.

`export/cover.ts` follows the same principle for front matter: it decides *what*
belongs on a cover — document type, title block, parties, version, status,
classification — and each renderer decides how to draw it. That is why the
document type follows the template, the classification follows the audience, and
the "Project" line disappears when it would merely repeat the title.

### pdfkit rather than headless Chrome

PDF rendering is hand-laid-out with pdfkit. Puppeteer would give easier
fidelity at the cost of a ~150 MB Chromium download, a sandbox to manage, and a
much larger desktop bundle. The cost of this choice is explicit pagination
logic in `export/pdf.ts`.

### Register is a function of audience, not a global setting

Technical writing builds to its conclusion; executive writing opens with it.
Rather than flattening every document to one voice, `executiveDirective()` in
the report generator (and its sibling in the presentation generator) adds an
inversion instruction *only* when the tone is `executive` or the audience is
`management` or `client`.

The constraint that survives regardless: an executive summary cannot claim
business impact the project does not record. Asked for a figure that was never
measured, the generator is instructed to say so rather than reach for
"significant" — which is the difference between a document that survives
scrutiny and one that reads well until questioned.

### Two-layer AI abstraction

Providers implement three primitives — text, structured JSON, and multimodal
image input. The thirteen product operations from the specification live one
layer up in `ai/services/` and are exposed through the `aiServices` facade in
`ai/index.ts`.

A literal reading would put `generateReport()` on the provider interface. That
would mean reimplementing report generation for every vendor. This way, adding
a provider is three methods; the prompts, schemas and safety fencing are shared.

## Request lifecycle

1. `onRequest` — CORS for the dev origin, then session load from the signed cookie.
2. `preHandler` — CSRF check on state-changing requests.
3. Route handler — `authorizeProject()` resolves the project and the caller's
   role, or throws 404 for non-members.
4. Validation — zod schema; failures return 422 with the offending field.
5. Work — repositories for reads and writes; anything slow is queued as a job.
6. `onResponse` — latency and status counters.

Errors funnel through one handler that returns `{ error: { code, message, details } }`
and never leaks a stack trace.

## Directory map

```
server/src/
  config.ts          environment, with production assertions
  app.ts             Fastify assembly, middleware, error shape
  db/
    migrations/      SQL, applied in order, each in its own transaction
    repositories/    all SQL lives here
  domain/
    types.ts         provenance, slots, tone/audience vocabulary
    templates.ts     report and deck structures (structure only, never content)
  ai/
    provider.ts      the transport interface + pricing
    providers/       openai · anthropic · mock (deterministic, offline)
    registry.ts      caching, usage accounting, budget guards
    safety.ts        prompt-injection fencing, secret detection
    context.ts       contextual retrieval
    services/        intake · vision · evidence · elaborate · consistency ·
                     report · presentation · qa
  files/             storage driver, upload validation, thumbnails
  export/            document assembly, validation, docx/pdf/pptx/html/md
    themes.ts        visual themes shared by every renderer
    cover.ts         document front matter — what appears, not how it is drawn
  jobs/              worker and handlers
  routes/            HTTP surface
  search/            FTS indexing
  security/          sessions, CSRF, project authorization

web/src/
  lib/api.ts         one client: CSRF, error envelope, SSE
  components/ui.tsx  primitives, including the provenance vocabulary
  pages/workspace/   the project workspace, one file per tab

desktop/             Tauri shell: sidecar lifecycle, settings, installer
```

## What is not built yet

Stated plainly rather than implied:

- **Semantic search.** The `embeddings` table and the retrieval seam exist;
  embeddings are not generated. Search is FTS5 today.
- **Diagram generation.** Slides and reports render ASCII diagrams when the
  model supplies them; nothing generates editable diagrams.
- **Voice notes.** The evidence model accepts arbitrary files, so the path is
  open, but no transcription pipeline is wired.
- **URL ingestion.** Deliberately omitted rather than half-done — it needs SSRF
  protection that is worth doing properly.
- **Malware scanning.** `files.scan_state` carries the column and the upload
  path has the hook; no scanner is integrated.
- **Multi-worker deployment.** The queue supports it; nothing coordinates
  multiple processes today.
