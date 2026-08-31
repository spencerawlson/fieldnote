# Data model

SQLite, accessed through `node:sqlite`. All SQL lives in
`server/src/db/repositories/`; nothing else in the codebase writes a query.

Migrations are numbered SQL files in `server/src/db/migrations/`, applied in
order, each inside its own transaction so a failure leaves no residue. Applied
migrations are recorded in `schema_migrations`.

## Entity map

```
users ──┬── sessions
        └── project_members ──── projects ──┬── steps ──┬── commands
                                            │           └── step_links
                                            ├── problems ──┬── investigations
                                            │              └── resolutions
                                            ├── evidence ──┬── files
                                            │              ├── image_analyses
                                            │              ├── ocr_results
                                            │              └── evidence_links ──▶ any subject
                                            ├── claims ─────────────────────────▶ any subject
                                            ├── tests · results · refs · tags
                                            ├── ai_insights · ai_runs · ai_cache
                                            ├── reports ──── report_sections
                                            ├── presentations ──── slides
                                            ├── questions ──── answers
                                            ├── exports
                                            ├── versions · audit_log · jobs
                                            └── search_index (FTS5) · embeddings
```

## The tables that carry the design

### `claims` — the knowledge layer

The heart of the product. One row is one statement with its origin attached.

| Column | Purpose |
| --- | --- |
| `subject_type` / `subject_id` | what the statement is about — polymorphic by design, because the same elaboration machinery serves steps, problems, projects and commands |
| `slot` | which field it fills (`what_was_done`, `why_it_matters`, `root_cause_explanation`, …) |
| `provenance` | `USER_FACT` / `EVIDENCE` / `AI_EXPLANATION` / `AI_INFERENCE` / `AI_RECOMMENDATION` — CHECK-constrained |
| `confidence` | `high` / `medium` / `low` |
| `supports_json` | `[{type, id}]` citations, validated against real records on write |
| `edited_by_user` | set by any human edit; protects the row from regeneration |
| `accepted` | `NULL` untouched, `1` accepted, `0` rejected |
| `depth` | which elaboration level produced it |

Indexed on `(subject_type, subject_id, position)` for rendering and on
`(project_id, provenance)` for the completeness calculation.

The polymorphic subject is a deliberate denormalisation. The alternative —
`step_claims`, `problem_claims`, `project_claims` — would triple the table
count and the query surface for no gain, since every consumer treats claims
uniformly. The cost is no foreign key on `subject_id`; deletion is handled in
the repository layer.

### `evidence_links` — the evidence chain

```
evidence ──▶ (step | problem | resolution | result | test | project)
             with role: supports · before · after · symptom ·
                        investigation · resolution · validation
             and origin: user | ai, plus its own confidence
```

The role is what makes "does this project prove the fix worked?" answerable: a
resolution is only rendered as validated when a link with role `validation` or
`after` exists. `UNIQUE (evidence_id, target_type, target_id, role)` means the
same capture can be both the symptom of one problem and the validation of
another without duplication.

### `files` vs `evidence`

Separate on purpose. `files` is bytes-and-metadata: checksum, MIME type,
dimensions, storage key. `evidence` is meaning: title, caption, review state,
what it supports. Re-uploading identical bytes reuses the file row (matched on
`(project_id, checksum)`) while creating a distinct evidence record — the same
screenshot can legitimately appear as evidence twice with different captions.

`storage_key` is never exposed to a client. Bytes are served only through an
authorised route.

### `versions` — history

Generic snapshots: `(entity_type, entity_id, revision)` with the full record as
JSON, plus who changed it and why. Written on every edit through the API.
Restoring snapshots the current state first, so a restore is itself undoable.

### `jobs` — the queue

`claimNextJob` selects and locks a queued row inside a transaction, so adding a
second worker process needs no schema change. `requeueStaleJobs` returns rows
stuck in `running` after a crash. Retries carry exponential backoff via
`run_after`.

### `search_index` — FTS5

A standalone FTS5 table with `entity_type`, `entity_id` and `project_id` as
`UNINDEXED` columns, tokenised `porter unicode61`. Indexing is synchronous on
write, so search is never stale.

User queries never reach the FTS parser raw: `toFtsQuery()` quotes every term,
because FTS5 treats `OR`, `AND`, `*` and `:` as operators and a user searching
for `AND` should not get a syntax error.

### `ai_runs` and `ai_cache`

`ai_runs` is the usage ledger: one row per call with tokens, cost estimate,
duration, and whether it was a cache hit. `ai_cache` stores deterministic
results keyed on a stable hash of service, model and inputs.

## Conventions

- **Ids** are prefixed and opaque: `stp_`, `evd_`, `clm_`. Readable in logs and
  URLs, and a mis-typed id fails validation rather than hitting the wrong table.
- **Timestamps** are ISO-8601 UTC strings. SQLite has no date type, and text
  timestamps sort correctly and survive a Postgres migration unchanged.
- **JSON columns** end in `_json` and are parsed automatically by the mapper.
- **Booleans** are `INTEGER` 0/1; the mapper converts on read. The mapper's
  `bool` list takes *column* names, not field names.
- **Soft deletes** (`deleted_at`) on projects, steps, problems, evidence, files,
  reports and presentations. Everything else deletes hard.
- **CHECK constraints** on every enum. An invalid state fails at the database,
  not three layers up.

## Porting to PostgreSQL

The schema is written to move. What changes:

| SQLite | PostgreSQL |
| --- | --- |
| `TEXT` primary keys | unchanged |
| `INTEGER` booleans | `BOOLEAN` |
| ISO-8601 `TEXT` timestamps | `TIMESTAMPTZ` |
| `*_json TEXT` | `JSONB` |
| FTS5 virtual table | `tsvector` column + GIN index |
| `INSERT … ON CONFLICT DO UPDATE` | unchanged |
| `PRAGMA` statements | dropped |

What needs code changes: `db/index.ts` (the connection wrapper is synchronous),
`searchProject`/`toFtsQuery` in `repositories/system.ts`, and the `embeddings`
table would become `pgvector`. Nothing in the services, routes or export layer
touches SQL.

## Retention and size

Uploads dominate. A 200-step project with 200 screenshots is roughly 400 MB of
images and under 20 MB of database. `MAX_UPLOADS_PER_PROJECT` bounds it.

`ai_cache` grows without bound by design — cache entries are cheap and their
value is avoiding re-billing. A cleanup job is a reasonable future addition.
