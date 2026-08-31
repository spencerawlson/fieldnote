# HTTP API

All endpoints are under `/api`. Requests and responses are JSON except uploads
(multipart) and downloads (binary).

## Conventions

**Authentication** — session cookie, set by register or login.

**CSRF** — every non-`GET` request must carry `X-Fieldnote-CSRF` with the token
returned by `/api/auth/me`, `/api/auth/login` or `/api/auth/register`.

**Errors** — one shape throughout:

```json
{ "error": { "code": "unprocessable", "message": "The request body is not valid",
             "details": [{ "path": "title", "message": "Must be at least 1 characters" }] } }
```

| Status | Meaning |
| --- | --- |
| 400 / 422 | malformed or invalid body — `details` names the field |
| 401 | not signed in |
| 403 | signed in, insufficient role, or CSRF failure |
| 404 | not found, **or** a project you are not a member of |
| 409 | conflict, or an export requested before it is ready |
| 413 | upload too large |
| 415 | unsupported or misdeclared file type |
| 429 | rate limited, or an AI budget ceiling reached |
| 502 | the AI provider failed |

**Long operations return 202** with a job record. Poll
`/api/projects/:id/jobs/:jobId` or subscribe to the SSE stream.

---

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `{email, name, password}` → user + `csrfToken`. First account becomes admin. |
| `POST` | `/api/auth/login` | `{email, password}` → user + `csrfToken` |
| `POST` | `/api/auth/logout` | |
| `GET` | `/api/auth/me` | current user + `csrfToken` |

## System

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | status, AI provider, offline flag |
| `GET` | `/api/meta` | categories, tones, audiences, depths, limits |
| `GET` | `/api/templates` | report and presentation templates, plus the visual theme registry |
| `GET` | `/api/metrics` | admin only — counters and latency percentiles |

## Projects

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/projects` | list with counts and completeness |
| `POST` | `/api/projects` | `{title, objective?, tone?, audience?, elaborationDepth?}` |
| `GET` | `/api/projects/:id` | project, role, completeness, counts |
| `PATCH` | `/api/projects/:id` | editor — snapshots the previous state |
| `DELETE` | `/api/projects/:id` | owner — soft delete |
| `GET` | `/api/projects/:id/members` | |
| `POST` | `/api/projects/:id/members` | owner — `{email, role}` |
| `GET` | `/api/projects/:id/timeline` | steps and problems in author order |
| `GET` | `/api/projects/:id/search?q=` | FTS across steps, evidence, OCR, claims |
| `POST` | `/api/projects/:id/reindex` | editor |
| `GET` | `/api/projects/:id/completeness` | score, per-category breakdown, what is missing |
| `GET` | `/api/projects/:id/insights` | `?scope=&scopeId=&state=` |
| `PATCH` | `/api/projects/:id/insights/:insightId` | `{state}` — dismissals persist |
| `GET` | `/api/projects/:id/privacy` | secret findings |
| `POST` | `/api/projects/:id/privacy/:findingId/acknowledge` | |
| `GET` | `/api/projects/:id/versions` | `?entityType=&entityId=` |
| `POST` | `/api/projects/:id/versions/:versionId/restore` | |
| `GET` | `/api/projects/:id/activity` | audit log |
| `GET` | `/api/projects/:id/usage` | AI token and cost totals |

## Steps and commands

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/projects/:id/steps` | steps with claims, commands, evidence links |
| `POST` | `/api/projects/:id/steps` | |
| `GET` | `/api/projects/:id/steps/:stepId` | |
| `PATCH` | `/api/projects/:id/steps/:stepId` | editing substance marks elaboration stale |
| `DELETE` | `/api/projects/:id/steps/:stepId` | soft delete, snapshot kept |
| `POST` | `/api/projects/:id/steps/reorder` | `{orderedIds}` |
| `POST` | `/api/projects/:id/steps/:stepId/links` | `{toStepId, relation}` |
| `POST` | `/api/projects/:id/steps/:stepId/commands` | `{language, content, output?}` |
| `PATCH` | `/api/projects/:id/commands/:commandId` | |
| `DELETE` | `/api/projects/:id/commands/:commandId` | |

## Problems, tests, results

| Method | Path |
| --- | --- |
| `GET` `POST` | `/api/projects/:id/problems` |
| `PATCH` `DELETE` | `/api/projects/:id/problems/:problemId` |
| `POST` | `/api/projects/:id/problems/:problemId/investigations` |
| `DELETE` | `/api/projects/:id/investigations/:investigationId` |
| `POST` | `/api/projects/:id/problems/:problemId/resolutions` |
| `PATCH` `DELETE` | `/api/projects/:id/resolutions/:resolutionId` |
| `GET` `POST` | `/api/projects/:id/tests` |
| `PATCH` `DELETE` | `/api/projects/:id/tests/:testId` |
| `GET` `POST` | `/api/projects/:id/results` |
| `PATCH` `DELETE` | `/api/projects/:id/results/:resultId` |
| `POST` | `/api/projects/:id/references` |
| `DELETE` | `/api/projects/:id/references/:refId` |

Writing `rootCause` through `PATCH /problems/:id` sets its provenance to
`USER_FACT` — a cause you record yourself is a fact, not an inference.

## Evidence

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/projects/:id/evidence/upload` | multipart, field `file`, repeatable. Queues analysis per file. |
| `GET` | `/api/projects/:id/evidence` | with analysis, OCR preview, links |
| `GET` | `/api/projects/:id/evidence/:evidenceId` | full OCR text |
| `PATCH` | `/api/projects/:id/evidence/:evidenceId` | |
| `POST` | `/api/projects/:id/evidence/:evidenceId/review` | `{verdict: confirm\|correct\|reject, description?, caption?}` |
| `DELETE` | `/api/projects/:id/evidence/:evidenceId` | |
| `POST` | `/api/projects/:id/evidence/:evidenceId/links` | `{targetType, targetId, role}` |
| `DELETE` | `/api/projects/:id/evidence/links/:linkId` | |
| `GET` | `/api/projects/:id/files/:fileId` | `?variant=original\|thumb` — membership re-checked |

## AI

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/projects/:id/ai/structure` | `{notes}` → proposal. **Writes nothing.** |
| `POST` | `/api/projects/:id/ai/structure/commit` | `{proposal, applyObjective?, analyze?}` |
| `POST` | `/api/projects/:id/ai/analyze` | 202 — the whole pipeline |
| `POST` | `/api/projects/:id/ai/review` | 202 — gap analysis only |
| `POST` | `/api/projects/:id/ai/link-evidence` | matches unlinked evidence |
| `POST` | `/api/projects/:id/steps/:stepId/ai/elaborate` | 202 |
| `POST` | `/api/projects/:id/steps/:stepId/ai/explain-commands` | |
| `POST` | `/api/projects/:id/problems/:problemId/ai/elaborate` | 202 |
| `POST` | `/api/projects/:id/evidence/:evidenceId/ai/analyze` | 202 |
| `POST` | `/api/projects/:id/ai/ask` | `{question}` → answer + sources |

## Claims

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/projects/:id/claims/:subjectType/:subjectId` | |
| `POST` | `/api/projects/:id/claims` | add your own statement |
| `PATCH` | `/api/projects/:id/claims/:claimId` | editing sets `editedByUser`, protecting it from regeneration |
| `DELETE` | `/api/projects/:id/claims/:claimId` | |

## Reports

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/projects/:id/reports` | includes a `stale` flag per report |
| `POST` | `/api/projects/:id/reports` | `{templateKey, title?, depth?, tone?, audience?, theme?, generate?}` |
| `GET` | `/api/projects/:id/reports/:reportId` | report, sections, exports |
| `PATCH` | `/api/projects/:id/reports/:reportId` | Includes `theme`; a theme change needs no regeneration |
| `POST` | `/api/projects/:id/reports/:reportId/generate` | 202 |
| `PATCH` | `/api/projects/:id/reports/:reportId/sections/:sectionId` | marks the section user-edited |
| `DELETE` | `/api/projects/:id/reports/:reportId` | |

## Presentations

| Method | Path | Notes |
| --- | --- | --- |
| `GET` `POST` | `/api/projects/:id/presentations` | |
| `GET` | `/api/projects/:id/presentations/:pid` | deck, slides, coaching findings |
| `PATCH` | `/api/projects/:id/presentations/:pid` | |
| `POST` | `/api/projects/:id/presentations/:pid/generate` | 202 |
| `POST` | `/api/projects/:id/presentations/:pid/notes` | 202 — speaker notes only |
| `POST` | `/api/projects/:id/presentations/:pid/review` | 202 — the coach |
| `POST` | `/api/projects/:id/presentations/:pid/reorder` | |
| `PATCH` `DELETE` | `/api/projects/:id/slides/:slideId` | |

## Q&A

| Method | Path |
| --- | --- |
| `GET` | `/api/projects/:id/questions` |
| `POST` | `/api/projects/:id/questions/generate` |
| `PATCH` | `/api/projects/:id/questions/:questionId` |
| `PATCH` | `/api/projects/:id/answers/:answerId` |
| `DELETE` | `/api/projects/:id/questions/:questionId` |

## Exports

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/projects/:id/exports` | `{subjectType, subjectId, format}` → 202 |
| `GET` | `/api/projects/:id/exports/:exportId` | status and validation findings |
| `GET` | `/api/projects/:id/exports/:exportId/download` | 409 until ready |

Reports export as `pdf`, `docx`, `html`, `md`; presentations as `pptx`, `pdf`,
`html`, `md`; a whole project as `json`. Validation findings are attached to the
export rather than blocking it.

The subject's `theme` decides how the file looks. An unknown theme key falls
back to the default rather than being stored and failing at render time.

## Jobs

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/projects/:id/jobs` | recent and active |
| `GET` | `/api/projects/:id/jobs/:jobId` | |
| `GET` | `/api/projects/:id/jobs/stream` | SSE: `snapshot` once, then `job` per update |

```js
const source = new EventSource(`/api/projects/${id}/jobs/stream`, { withCredentials: true });
source.addEventListener('job', (event) => console.log(JSON.parse(event.data)));
```

## Worked example

```bash
BASE=http://localhost:4000
COOKIE=/tmp/fn.txt

CSRF=$(curl -s -c $COOKIE -X POST $BASE/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","name":"You","password":"a-long-password"}' | jq -r .csrfToken)

auth=(-b $COOKIE -H "x-fieldnote-csrf: $CSRF" -H 'content-type: application/json')

PID=$(curl -s "${auth[@]}" -X POST $BASE/api/projects \
  -d '{"title":"Apache deployment"}' | jq -r .project.id)

# Structure notes — returns a proposal, writes nothing
curl -s "${auth[@]}" -X POST $BASE/api/projects/$PID/ai/structure \
  -d '{"notes":"Installed Apache.\nPort 80 was in use.\nStopped the conflict.\nApache started."}' \
  > proposal.json

# Accept it and run the pipeline
jq '{proposal: .proposal, analyze: true}' proposal.json |
  curl -s "${auth[@]}" -X POST $BASE/api/projects/$PID/ai/structure/commit -d @-

# Upload evidence
curl -s -b $COOKIE -H "x-fieldnote-csrf: $CSRF" \
  -F "file=@screenshot.png" $BASE/api/projects/$PID/evidence/upload

# Generate and download a report
RID=$(curl -s "${auth[@]}" -X POST $BASE/api/projects/$PID/reports \
  -d '{"templateKey":"technical"}' | jq -r .report.id)

EID=$(curl -s "${auth[@]}" -X POST $BASE/api/projects/$PID/exports \
  -d "{\"subjectType\":\"report\",\"subjectId\":\"$RID\",\"format\":\"pdf\"}" | jq -r .export.id)

curl -s -b $COOKIE -o report.pdf \
  $BASE/api/projects/$PID/exports/$EID/download
```
