# Testing

```bash
npm test
```

58 tests, four suites, all against the deterministic offline provider — no API
key, no network, no fixtures to refresh.

| Suite | Tests | Covers |
| --- | --- | --- |
| `acceptance.test.ts` | 18 | The whole product, end to end |
| `security.test.ts` | 19 | Authorization, uploads, injection, secrets |
| `units.test.ts` | 13 | Knowledge-model invariants, templates, exports, provider |
| `themes.test.ts` | 8 | That themes reach the exported bytes in every format |

Run one suite:

```bash
node --disable-warning=ExperimentalWarning --test server/test/acceptance.test.ts
```

## What the acceptance suite actually asserts

It runs the scenario from the product specification — an Active Directory lab
documented from rough notes and six screenshots — and checks the behaviour that
makes this a documentation tool rather than a text generator:

- **Structure preserves wording.** The author's sentence survives verbatim on
  every step, and a failure line becomes both a failed step *and* a problem.
- **Elaboration adds understanding.** Claims must include `USER_FACT` *and*
  `AI_EXPLANATION` — the AI has to explain, not merely restate.
- **`USER_FACT` claims are grounded.** Every one is checked for word overlap
  with the original notes. A model that invents a fact and labels it
  `USER_FACT` fails the build.
- **Domain-appropriate explanation.** The DNS step must carry an explanation
  mentioning resolution or service discovery.
- **The evidence chain forms.** The failure screenshot attaches to the problem
  it evidences, with a symptom role.
- **Uncertainty is preserved.** A derived root cause must not be recorded as
  `USER_FACT`, and must carry a confidence.
- **Completeness is honest.** The score is labelled an estimate, with a
  per-category breakdown.
- **The report has real structure.** Headings, prose and figures, with figure
  numbers sequential in document order.
- **The deck stays a deck.** Slide bullet text is bounded; notes carry the
  detail.
- **Q&A separates project fact from general knowledge**, and cites what it drew
  on.
- **Human corrections survive regeneration** — the test edits a claim,
  regenerates the step, and asserts the edit is still there.
- **Every format really exports.** PDF starts `%PDF-`, DOCX and PPTX start `PK`,
  HTML has a doctype, Markdown starts with a heading.
- **One source of truth.** Changing a project fact marks the report stale;
  regenerating clears it.
- **OCR text is searchable** — searching for text that only ever appeared in a
  screenshot finds it.

## Themes are asserted against the bytes

A theme picker that only changes a preview is worse than none, so
`themes.test.ts` renders the same fixture under different themes and asserts the
output actually differs — DOCX and PPTX zips, PDF content streams, and the CSS
custom properties in the HTML. It also checks the academic theme really is
serif and really does drop the rule under section headings, because those are
the differences a reader would notice first.

## Why the offline provider, not mocks

`providers/mock.ts` implements every service contract with rules, driven by a
`mockContext` the services pass alongside the prompt. Tests therefore exercise
the real orchestration, the real database writes, the real renderers and the
real export path. A stub returning canned JSON would test the test.

The trade-off is stated plainly: these tests verify the *machinery* — that
provenance is enforced, that claims survive regeneration, that PPTX is valid —
not the *quality* of a real model's prose. That needs a human reading output
with a key configured.

## The harness

`server/test/helpers.ts` sets the environment before any application module
loads (config is read once at import), giving each suite an in-memory database
and a temporary storage directory. `createClient()` returns a typed client that
carries the session cookie and CSRF token, including multipart upload and binary
download.

`makePng()` builds a real PNG by hand — signature, IHDR, deflated IDAT, IEND —
so magic-byte validation, `sharp` and the PDF and PPTX embedders all run their
genuine code paths rather than being handed a fixture that happens to work.

Jobs run through `drainJobs()`, which processes the queue synchronously instead
of polling. Same handlers, deterministic ordering, no sleeping.

## Adding tests

Keep the naming behavioural — `'preserves human-edited claims across regeneration'`,
not `'test replaceGeneratedClaims'`. The test names are the specification.

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, cleanupStorage } from './helpers.ts';

describe('the thing', () => {
  let app, client;
  before(async () => {
    const { buildApp } = await import('../src/app.ts');
    await import('../src/jobs/handlers.ts');   // registers handlers
    app = await buildApp();
    client = await createClient(app);
  });
  after(async () => { await app?.close(); cleanupStorage(); });

  it('behaves', async () => {
    const response = await client.post('/api/projects', { title: 'X' });
    assert.equal(response.status, 201);
  });
});
```

Import application modules **inside** `before`, not at the top — the harness must
set environment variables first.

## Type checking

```bash
npm run typecheck    # server and web
```

The server is checked with `erasableSyntaxOnly`, which enforces that it stays
runnable by Node without a build step. Code that would need transpiling fails
the check.

## Manual verification

Some things need a person:

- Open an exported DOCX in Word: the table of contents populates on open (it is
  a field), headers and page numbers appear, figures sit near their text, and
  the cover page reads as front matter rather than a centred title.
- Read an executive-audience report next to a technical one generated from the
  same project. The first should open with outcomes and the second with method.
  If they read the same, the register instruction is not working — and no
  assertion will catch that.
- Open an exported PPTX in PowerPoint: speaker notes are in the notes pane, not
  a text box; 16:9; slide numbers present.
- Read a report generated with a real key: is the elaboration actually
  informative, or filler? That is a judgement no assertion makes.
- The desktop build: launch, sign in, restart, confirm you are still signed in
  (the session secret persists), and confirm no `node.exe` survives closing the
  window.

## Coverage gaps

Stated rather than implied:

- No browser-level UI tests. The interface is exercised only through the API.
- No load testing.
- The real provider adapters are not tested against live APIs; only their JSON
  recovery and error mapping are covered.
- PDF and DOCX output is asserted structurally (valid file, correct magic
  bytes, plausible size), not visually.
