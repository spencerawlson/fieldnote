# AI architecture

The product requirement is unusual and worth stating precisely: **the AI must
elaborate, and must not invent.** Those pull against each other. Everything in
this layer exists to hold both at once.

## Two layers

```
ai/services/*          ← thirteen product operations, each with its own prompt,
                         JSON schema, validation and context selection
      │
ai/registry.ts         ← caching · usage accounting · budget guards · fallback
      │
ai/provider.ts         ← three primitives: complete(), completeJson(), images
      │
providers/openai.ts    providers/anthropic.ts    providers/mock.ts
```

A provider implements three methods. Adding one does not mean reimplementing
report generation. The named operations from the product specification
(`analyzeText`, `analyzeImage`, `elaborate`, `structureProject`,
`generateReport`, `generatePresentation`, `generateQuestions`,
`reviewPresentation`, …) are exported from `ai/index.ts` as the facade.

### Model routing

Three workload classes, each independently configurable:

| Class | Used for | Default |
| --- | --- | --- |
| `reasoning` | report, deck, elaboration at depth ≥ 3, consistency analysis | `gpt-5` |
| `fast` | short structured calls, command explanation, shallow elaboration | `gpt-5-mini` |
| `vision` | screenshot analysis and transcription | `gpt-5-mini` |

## The services

| Service | Input | Output |
| --- | --- | --- |
| `intake.structure` | free-form notes | proposed steps + problems + resolution links |
| `vision.analyze` | image bytes + metadata | description, observations, entities, transcription |
| `ocr.vision` | image bytes | transcription only |
| `evidence.classify` | evidence + steps + problems | proposed links with roles and confidence |
| `elaborate.step` | one step + its evidence + neighbours | provenance-labelled claims |
| `elaborate.problem` | problem + investigations + resolutions | claims + proposed root cause |
| `elaborate.project` | whole project, truncated | project-level framing claims |
| `command.explain` | commands | per-command explanation |
| `consistency.check` | whole project | gap and contradiction findings |
| `report.generate` | project knowledge | prose sections |
| `presentation.generate` | project knowledge + slide plan | slides + notes |
| `presentation.notes` | slides + project | speaker notes |
| `coach.review` | slides + what the project supports | pre-presentation findings |
| `qa.generate` | project knowledge | questions with grounded answers |
| `assistant.chat` | question + retrieved context | answer with sources |

Each is a separate call with its own schema. There is no single mega-prompt.

## Provenance is the mechanism

Every generated statement is a row with a label:

```
USER_FACT          restates what the author wrote — never adds detail
EVIDENCE           read from an artifact — cites the evidence id
AI_EXPLANATION     general technical knowledge, true independent of this project
AI_INFERENCE       a conclusion drawn — may be wrong, usually low/medium confidence
AI_RECOMMENDATION  advice — never phrased as history
```

The rules the model is given (`ELABORATION_RULES` in `services/elaborate.ts`)
are enforced downstream, not merely requested:

- The report renderer maps `AI_RECOMMENDATION` to a recommendation callout and
  `AI_INFERENCE` to an inference callout. A model that mislabels produces a
  visibly odd document rather than a confident falsehood.
- Claims citing evidence not linked to the subject have the citation stripped
  in `elaborateStep` — a fabricated reference cannot survive.
- Proposed evidence links are filtered against the ids actually supplied.
- A model-derived root cause is written with `root_cause_provenance =
  AI_INFERENCE`; only a human edit through the API promotes it to `USER_FACT`.
- Resolutions are only described as validated when the project holds evidence
  with a `validation` or `after` role. Otherwise the report prints the claim as
  stated-but-unevidenced.

### Elaboration depth

Four levels, changeable after generation. Depth controls both the instruction
given and how many slots are admitted into the report (3 / 6 / 10 / 20). Level 4
is explicitly told that "depth must not become padding" — the engine is also
told to skip any slot that would only produce filler, which is why a short
preparation step legitimately returns three claims and a security change
returns ten.

## Prompt injection

Everything a user types, uploads, or that OCR reads out of a screenshot is
untrusted. A screenshot of a terminal can legitimately contain the words
"ignore previous instructions".

Three rules, implemented in `ai/safety.ts`:

1. **System instructions are assembled from constants in this codebase only.**
   Project content never reaches the system slot.
2. **Untrusted content is fenced with a random nonce.** Content cannot forge the
   closing delimiter, because it does not know the nonce.
3. **Delimiter-imitating sequences are neutralised before fencing**, including
   zero-width characters used to smuggle a forged tag past a literal comparison.

Every call opens with `SAFETY_PREAMBLE`, which states that fenced content is
data, that a request inside it to change the task is itself an observation
about the content, and that missing information is reported as missing.

`detectInjection()` additionally flags suspicious content so the user is told
their evidence contains instruction-like text — surfaced, not silently handled.

## Context management

Sending the whole project on every call is slow, expensive, and degrades output.
`ai/context.ts` builds the slice each task needs:

- **Step elaboration** — one step, its evidence at 2000 chars, its immediate
  neighbours, related problems.
- **Report generation** — the full skeleton with evidence text truncated to 900
  chars, capped at 40 000 characters of fenced content.
- **Assistant** — full-text search on the question drives which steps and
  evidence are included at all.

Redacted OCR text is what leaves the machine whenever secrets were detected.

## Cost control

`ai/registry.ts` is the only path to a provider.

- **Caching.** Deterministic calls are keyed on a stable hash of their inputs.
  Step elaboration keys on the step's `content_hash` plus depth, tone and
  audience — so re-running analysis after adding one step does not re-bill the
  other twenty. Image analysis keys on the file checksum.
- **Staleness instead of re-running.** Editing a step's substance flips
  `ai_state` to `stale` rather than triggering a call.
- **Usage accounting.** Every call writes an `ai_runs` row with tokens,
  duration, cost estimate and cache status, exposed per project.
- **Budget guards.** `AI_USER_MONTHLY_CENTS` and `AI_PROJECT_MONTHLY_CENTS`
  reject calls past a ceiling with a clear error.
- **Honest pricing.** Unknown models fall back to a mid-range estimate flagged
  `estimated: true` rather than being reported as free.

## The offline provider

`providers/mock.ts` is not a stub. It is a rule-based implementation of every
service contract, driven by a `mockContext` the services pass alongside the
prompt (real providers ignore it). It means:

- the product runs end to end with no API key and no network;
- the test-suite asserts on real structure rather than on mocks of itself;
- export formatting can be worked on without spending tokens.

Its prose is deliberately generic where it would otherwise have to invent domain
facts, and it labels such text `AI_EXPLANATION` at low confidence — exactly what
is asked of a real model. The intake analyzer's rule-based splitting is good
enough that the offline experience is genuinely useful rather than a placeholder.

## Failure handling

- Retries with exponential backoff on 408/409/429/5xx and network errors.
- Structured calls retry once with the validation error fed back.
- `extractJson()` recovers JSON wrapped in prose or code fences.
- A failed AI call never loses user work: records are saved before any job is
  queued, and job failure is recorded against the job, not the data.
- In the project-wide pipeline, one bad screenshot does not abort the run — it
  is collected into a `failures` list reported when the job completes.
- If the configured provider has no key, the app falls back to the offline
  provider, logs a warning and shows an offline banner rather than failing to
  start.

## Adding a provider

1. Implement `AIProvider` in `ai/providers/` — `complete`, `completeJson`,
   `modelFor`, `supportsVision`.
2. Add its pricing to `PRICES` in `ai/provider.ts`.
3. Register it in `getProvider()` in `ai/registry.ts`.

No service, prompt or schema changes.
