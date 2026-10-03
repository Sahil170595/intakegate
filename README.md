# Intakegate

An auditable intake-triage pipeline: advisory perception, deterministic priority rules, structured output, and review-only orchestration. This is the full TypeScript engine and CLI, not the reduced browser demonstration.

**Synthetic research software, not a clinical service.** Use invented messages only. No real patient data, diagnosis, emergency response, insurance verification, appointment booking, outbound delivery, or external task system is supported. A priority label is a review proposal, not a clinical assessment. All items require human review. An escalation record does not notify anyone.

[Portfolio](https://chimeraforge.vercel.app/) · [Work](https://chimeraforge.vercel.app/work) · [Browser demo](https://chimeraforge.vercel.app/projects/agents-and-evaluation/intake-triage). The browser demo ports only `score.ts`, rule for rule, and scores every combination of the signals it reads; it reproduces this repository's fixture result from the keyless perception's signal bundles. It does not read message text or run orchestration.

## Quickstart

Node.js 22 or newer. The release was checked with Node 22.19.0 and the versions pinned in `package-lock.json`.

```sh
npm ci
npm run check
npm run triage
npm run validate
npm run schema
```

The default run uses `fixtures/inbox.synthetic.json` and `fixtures/resources.synthetic.json`, with **no network access needed**. It creates `.intakegate/output.json` and `.intakegate/trace.json`. Writes are exclusive: existing files are not overwritten. For another run, choose new paths:

```sh
npm run triage -- --output .intakegate/second.json --trace .intakegate/second-trace.json
npm run validate -- --output .intakegate/second.json --trace .intakegate/second-trace.json
```

`npm test` uses Node's test runner with one test worker; no browser, Docker, database, downloaded model, or live provider is required. For an existing dependency installation, run `node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 test/intakegate.test.ts` and `node node_modules/typescript/bin/tsc --noEmit` without installing again. `TSX_DISABLE_CACHE=1` disables the runner's transform cache on disk-constrained systems.

## Underlying System

The implemented system treats inbound text as evidence rather than allowing a language model to dispatch actions. Four channels share one structured contract: referral text, voicemail transcripts, portal messages, and email. Attachments are filenames only; there is no OCR, audio transcription, mailbox ingestion, or document reading.

```text
validated inbox + synthetic resources
             |
     perceive: lexical signals + optional fast/strong model cascade
             |  seven intake fields, proposed class, safety/time/action signals
     score: categorical safety gates, then operational accumulator
             |  final class, priority, gate, review reason, weighted rationale
     orchestrate: classification-specific local queries and artifact drafts
             |  captured per-item calls, task IDs, unsent reply, missing fields
     assemble: explicit structured output + captured evidence
             |
     validate: schema, coverage, counts, trace equality, artifact consistency
```

### Perception Is Advisory

[`perceive.ts`](src/triage/perceive.ts) preserves the complete lexical extraction, forced structured model tool, targeted cascade, and deterministic fallback. The lexical layer always runs. It detects safety phrases, same-day language, shouting, marketing, and FYI markers; extracts identity/contact, discipline, concern, payer, and member fields; and proposes a class when models are unavailable.

The optional model route makes a fast perception call, then requests strong review when safety is flagged, confidence is below 0.75, ambiguity is reported, or lexical/model safety evidence conflicts. Each call has its own 15-second abort timer. Fast failure goes to deterministic fallback; strong failure keeps the valid fast result. SDK retries are disabled in this release, limiting the route to at most two requests per item. The model never sets final priority, selects routing tools, or generates audit call IDs.

Both tiers emit a forced `emit_triage_signals` tool payload. This public release adds schema validation before accepting that payload. Deterministic extraction still takes precedence over model-extracted fields when a lexical match exists. That helps reproducibility but can overwrite a contextually correct model value with an incorrect date or name match.

### Rules Own Priority

[`score.ts`](src/triage/score.ts) is a pure function with explicit precedence:

1. A lexical safety hit, or a model caregiving-safety signal, selects **P0** and `safeguarding`, bypassing operational weights.
2. A non-caregiving model safety signal selects **P1**. It does not automatically create a clinical-lead task or deliver a notification.
3. Otherwise, start at zero: actionable same-day language adds 2; a time-sensitive complaint adds 1; passive FYI subtracts 1; marketing subtracts 2. Shouting adds **zero**. Scores at least 2 yield P1, at most -2 yield P3, and intermediate scores yield P2.
4. Structural classification overrides include incomplete referral fields and fixture-specific existing-patient recognition.

The two known-patient literals are explicitly fictional and match the synthetic roster. This is retained fixture-specific behavior, not general identity resolution. Patient lookup later performs a separate exact name/date query against local records; a model proposal is not proof of an existing patient.

### Orchestration And Audit

[`orchestrate.ts`](src/triage/orchestrate.ts) retains the full class-specific routing: safety review, same-day scheduling review, referrals, existing-patient requests, clinical questions, missing paperwork, billing, spam, and default acknowledgement. Adverse coverage evidence defers slot search and proposes billing review. Unknown coverage can still surface suggestions; it does not authorize a booking. Spanish cues select a Spanish draft and language-filtered provider search. Only the first extracted discipline controls slot matching.

[`assemble.ts`](src/triage/assemble.ts) rebuilds every output field, normalizes disciplines, forces human review, and passes through the actual captured calls. Async-local batch/item contexts keep concurrent batches isolated, while execution within each batch is serial. A final per-item catch keeps failed items visible. Unlike the earlier fallback, the release preserves an already scored safety priority and any completed local task/draft evidence when a later adapter fails. An unscored pipeline failure receives P1 manual review; this is a fallback convention, not a validated safety guarantee.

The public resource adapters, types, CLI, schema, and validator are independent implementations around the retained pipeline. They are not production integrations. The release also reports missing child identity, avoids claiming a successful patient match after an empty lookup, and makes provider execution explicit opt-in. These are guarded release changes, not claims that all earlier versions already behaved this way.

## What The Tools Actually Do

| Tool | Implemented behavior | Not implemented |
| --- | --- | --- |
| `search_patient` | Exact, case-insensitive name and optional DOB query of active synthetic records | EHR access, fuzzy matching, identity/consent verification |
| `verify_insurance` | Exact synthetic payer/member lookup; unmatched pairs return `unknown` | Real eligibility, authorization approval, insurer access |
| `lookup_policy` | Read an authored synthetic routing note | Approved clinical/legal policy retrieval |
| `find_slots` | Filter synthetic providers by discipline/language and non-full capacity; sort openings; return up to five | Age matching, current calendar access, reservation |
| `create_task` | Generate an ID and capture local task-draft metadata in the trace | External persistence, assignment, staff receipt/completion |
| `draft_message` | Capture supplied text and an unsent draft ID | Sending email, portal messages or phone calls |
| `escalate` | Record a proposed review request; `notified: false` | Paging, emergency response, delivered escalation |
| `hold_slot` | Record a non-reserving request with `reserved: false`; never used by the agent | Any actual slot hold or appointment |

Read queries perform real local computation. Action tools are deliberate **stubs**, not partially connected services. Draft language remains hypothetical and requires review; promises inside an unsent draft are not fulfilled by this program. Policy text is not interpreted by a model or a rule parser: routes are coded explicitly, and lookup records supporting context only.

## Findings

### Engineering Lessons From The Full Pipeline

An earlier development investigation traced unintended lexical fallback to a deadline shared by both perception tiers. The implemented response was a per-call abort budget, so escalation did not inherit an already exhausted budget. This release exercises the cascade and its failure selection using invented in-memory responses; it does **not** reproduce that historical provider experiment, publish its responses, or establish live latency/recall.

Separating perception from priority makes the weighted decision reproducible and inspectable, but does not make inputs semantically correct. The safety backstop intentionally favors review over silence. That preserves P0 when the model disagrees with a lexical hit, while also turning a negated phrase such as “no abuse” into a false positive. A strong-tier result can replace a fast-tier safety signal when the lexical backstop is silent. Therefore the cascade is not a monotonic safety guarantee.

Trace integrity comes from recording tools outside model control, rather than asking the model to describe actions it claims to have taken. The validator checks evidence in both directions and ties task IDs and draft text to captured records. This establishes local consistency, not signed provenance or real-world execution. A party able to rewrite both output and trace can fabricate a consistent pair.

### New Synthetic Reproduction

The default cohort contains 12 newly authored cases. Running the offline CLI gives **1 P0, 1 P1, 9 P2, and 1 P3**, with **12 requiring human review**. These are fixture outcomes, not accuracy, clinical improvement, a held-out benchmark, or transplanted historical scores. The two adverse-coverage cases produce billing-review drafts without slot search. The Spanish case queries Spanish-capable SLP fixture providers. Marketing produces no calls. No case books, sends, or notifies anything.

The focused suite covers analytical weight combinations, categorical precedence, missing identity, coverage gating, Spanish/capacity filtering, chronological ordering, non-reservation, deterministic replay, concurrent session isolation, late failures, normalization, malformed model payloads, and bidirectional trace/artifact checks. Its mocked model responses are invented test inputs, not saved provider outputs.

## Failure Cases And Limits

- The lexical layer does not understand negation, quoted text, or caregiving context. It misses unseen paraphrases and may promote harmless text to P0. No measured safeguarding recall/precision is claimed.
- Any ISO-like date may become the DOB, and the first contact/name match may be unrelated. A synthetic member ID can resemble a phone number. Extraction is not trustworthy identity evidence.
- Known-patient classification uses two fixture literals and substring checks, while the adapter lookup is exact. Model proposals can also choose the existing-patient route without verified identity.
- In fallback mode, question-shaped billing messages may become clinical questions, and FYI messages can enter the default acknowledgement route despite `requires_action: false`. Human review and unsent drafts do not solve classification quality.
- P1 non-caregiving safety is a priority gate, not guaranteed clinical-lead routing. Strong review can lower a fast-only safety signal. Neither local escalation nor an error fallback guarantees that someone sees a message.
- Insurance status is fixture evidence only. `unknown` still permits slot suggestions; prior authorization is a note, not an approval gate. No booking path exists.
- Slots are fixed synthetic dates, not a live calendar. Age range and preferences are not applied. Matching handles one discipline at a time; Spanish detection and draft templates are heuristic, not qualified translation.
- Schema validation cannot establish medical safety, consent, legal compliance, delivery, or factual correctness. Traces contain message-derived data: real PHI must not be entered, logged, or committed.
- There is no persistence beyond optional local JSON files, authentication, retention policy, staff UI, delivery queue, production monitoring, or connected provider qualification.

## Programmatic Reproduction

[`runtime.ts`](src/runtime.ts) exposes the validated batch boundary:

```ts
const { output, trace } = await runLocalBatch(inventedInbox, inventedResources, {
  now: () => "2030-01-01T09:00:00.000Z",
  id: (() => { let n = 0; return () => `replay-${++n}`; })(),
});
validateBatch(output, inventedInbox, trace);
```

Import `runLocalBatch` from `src/runtime.ts` and `validateBatch` from `src/validate.ts`. Fixed clock/ID factories make complete offline JSON replay deterministic. Without them, priority/routing are deterministic for fixed inputs, but timestamps and ULIDs vary. Inputs are capped at 100 items; the CLI caps each JSON input file at 1 MB. Unknown fields, duplicate identifiers, invalid channels/dates, and invalid resource records are rejected before execution. `npm run schema` emits the versioned output JSON Schema from [`schema.ts`](src/schema.ts).

### Optional Model Execution

Offline mode is the default even when a credential happens to be present. `.env` is never auto-loaded. The CLI requires `--allow-model` plus an explicitly exported `ANTHROPIC_API_KEY`; library calls require `INTAKEGATE_ALLOW_MODEL=1`. `ANTHROPIC_FAST_MODEL` and `ANTHROPIC_STRONG_MODEL` can override model identifiers. The `model_path` strings retain the pipeline's historical tier labels rather than identifying every overridden model.

Enabling this route sends message text and attachment filenames to the configured SDK provider and may incur charges. Use invented input only and assess provider/data policies separately. **No live provider call was made for release verification.** Model availability, quality, SDK transport behavior under real cancellation, and production deployment remain unqualified. Output `execution_mode: "synthetic-local"` describes the action/resource boundary, not proof that optional perception was offline.

## License And Support

First-party code, documentation, and invented fixtures are MIT-licensed. Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No third-party fixture corpus or service data is distributed. The public repository begins with one clean root commit and contains no earlier history or runtime outputs.

Issues should include a minimal invented input, Node version, expected versus observed rule behavior, and failing test. Never attach patient information, credentials, private communications, or production traces. This is a reproducible engineering artifact, not a supported care workflow or endorsed integration.
