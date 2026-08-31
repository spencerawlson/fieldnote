# Contributing

## Setup

```bash
npm install
cp .env.example .env     # a key is optional; without one you get offline mode
npm run dev              # API on :4000
npm run dev:web          # UI on :5173, proxying /api
```

`npm test` must pass without an API key. If a change makes the suite need one,
the change is wrong.

## Where things go

| Kind of change | Where |
| --- | --- |
| New table or column | `server/src/db/migrations/NNN_*.sql` + a repository function |
| Any SQL | `server/src/db/repositories/` — nowhere else |
| New AI operation | `server/src/ai/services/`, exported from `ai/index.ts` |
| New AI provider | `server/src/ai/providers/`, registered in `registry.ts` |
| New endpoint | `server/src/routes/`, with a zod schema |
| Long operation | a job handler in `server/src/jobs/handlers.ts` |
| New export format | `server/src/export/`, wired into `render.ts` |
| Interface | `web/src/pages/workspace/` — one file per tab |
| Desktop shell | `desktop/src/` — lifecycle only, never product logic |

## Rules that are not negotiable

**Provenance.** Any new generated content carries a provenance label and a
confidence. If you cannot say which of the five categories a sentence belongs
to, the feature needs rethinking before it needs code.

**Never assert without support.** Do not add a path that states an operation
succeeded, was tested, or was validated unless the project record says so. When
evidence is absent, say it is absent.

**Human edits win.** Any new generated entity needs an `edited_by_user`
equivalent and must survive regeneration.

**Untrusted content stays fenced.** Everything user-supplied or uploaded that
reaches a model goes through `fenceUntrusted()`. System prompts are assembled
from constants in this repository only.

**Model output is untrusted too.** Validate ids the model returns against the
records you supplied. Never write a model-supplied id without checking it
exists.

**No SQL outside repositories**, and no query built by string concatenation.

**Erasable TypeScript only** in `server/`. No enums, no parameter properties, no
namespaces — the backend runs without a build step and must keep doing so.
`npm run typecheck` enforces it.

## Style

Match the surrounding code. What is worth knowing beyond that:

- **Comments explain why, not what.** If a comment restates the line below it,
  delete it. The ones worth writing record a decision — why 404 instead of 403,
  why the session secret is generated before the backend starts.
- **Name functions for what they do to the domain.** `replaceGeneratedClaims`,
  not `updateClaims`.
- **Errors are sentences a user can act on.**
  `throw badRequest('Generate the report before exporting it')`, not
  `throw new Error('bad state')`.
- **Repositories return domain records, not rows.** The mapper handles
  snake_case, JSON columns and booleans. Its `bool` list takes **column** names,
  not field names — getting this wrong is silent and surfaces as `1` where you
  expected `true`.

## Adding an AI service

1. Write the prompt and JSON schema in `server/src/ai/services/`.
2. Fence every piece of project content with `fenceUntrusted()`.
3. Give it a `mockContext` so the offline provider can implement it, and add a
   handler in `providers/mock.ts`. **A service with no offline implementation
   breaks the test suite for everyone without a key.**
4. Validate the response: check enums, filter ids against what you supplied.
5. Export it from `ai/index.ts`.
6. If it takes more than a second, call it from a job handler, not a route.

## Before opening a pull request

```bash
npm run typecheck
npm test
```

For changes to generation or export, also generate a report and a deck with a
real key and read them. Assertions catch structural breakage; only reading
catches output that is technically valid and useless.

For changes to the desktop shell, build it and confirm that closing the window
leaves no orphaned `node` process.

## Commits

Explain the reasoning, not the diff:

```
Preserve user-edited claims across regeneration

replaceGeneratedClaims deleted every claim for a subject, so a user who
corrected an explanation lost it the next time they pressed Regenerate.
It now keeps rows with edited_by_user or accepted set, and skips those
slots in the incoming batch.
```
