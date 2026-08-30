# Knowledge Configuration Evaluation

This is an administrator-run evaluation for a live Archestra installation. It
runs **inside a platform container** and deliberately uses that container's real
configuration, database, secrets manager, embedding/OCR/reranking providers,
models and network connections. It does not use PGlite, recorded responses,
synthetic vectors, replacement rankers or profile-specific environment
overrides.

Administrator-started runs can persist evaluation-only embedding, reranking,
OCR, and BM25 settings. The worker resolves the stored key IDs, then passes the
resolved clients and numeric settings only through evaluation ingestion and
queries. Organization settings and deployment config are never mutated.

The content under `fixtures/` is synthetic and evaluator-specific. The runner
sends that fixed content through the live configured services; it does not query
an organization's connector documents. No current fixture or golden query comes
from customer content, user logs, TREC, BEIR, or another external benchmark.

The compiled command is included in the production backend image:

```sh
kubectl exec -n <namespace> deploy/<archestra-release> -- \
  node /app/backend/dist/standalone-scripts/kb-retrieval-eval.mjs run \
  --organization-id <organization-uuid> \
  --out /tmp/kb-eval-before.json
```

## Administrator UI

**Settings > Knowledge > Knowledge configuration evaluation** exposes the same
runner as a DB-backed administrator workflow. Administrators select any set of
Knowledge components, with changed or never-evaluated configuration selected by
default. The UI follows the Guardrails table pattern: its header checkbox
selects or clears all available checks, Select new and changed restores the suggested
set, and unavailable checks remain uniform disabled rows with guidance. It
queues execution on the platform task worker, polls durable stage progress,
supports cooperative cancellation, stores the JSON artifact, and compares the
latest completed runs.

The product surface is beta-gated. It exists only when
`ARCHESTRA_KNOWLEDGE_BASE_EVALUATION_ENABLED=true`, or when that value is unset
and the deployment-wide `ARCHESTRA_BETA=true`. With the gate off, the Settings
card is not mounted and every evaluator API returns 404. The direct in-pod CLI
remains available to platform operators.

Chunking, keyword ranking, and context expansion are marked **Offline** and take
an isolated path through the production chunker/PostgreSQL ranking/context code:
they make no upstream provider call and incur no model billing. Every other
component is marked **Uses provider**. A partial run ingests only the fixtures
needed by its selected components and explicitly disables optional unselected
stages, so a reranking-only run does not also claim to evaluate query expansion,
for example.

The UI does not execute a second implementation. Its task handler calls
`runInstance` with progress/cancellation callbacks; the CLI calls the same
function without them. One run can be active per organization, while execution
is globally serialized because the BM25 refresh covers every organization.
Fixture IDs are persisted as soon as they are created so a task retried after a
worker restart removes the prior attempt before starting again.

Run it once, change a Knowledge setting through the platform, run it again,
copy the two artifacts out of the pod, then render the per-query delta:

```sh
node /app/backend/dist/standalone-scripts/kb-retrieval-eval.mjs diff \
  /tmp/kb-eval-before.json /tmp/kb-eval-after.json
```

Use `--all` on `diff` to include unchanged queries. `--limit` changes only how
many product results are scored; it does not change a platform setting. The
runner accepts no model credential, endpoint or `ARCHESTRA_KNOWLEDGE_BASE_*`
override by design.

## What one run does

1. Resolves the selected organization's embedding, OCR and reranker settings
   through `resolveEmbeddingConfig`, `resolveOcrConfig` and
   `resolveRerankerConfig`, and reads the deployment's actual `config.kb`.
2. Creates a uniquely named evaluation knowledge base and connector inside that
   organization.
3. Selects only fixture documents owned by the chosen components. Text,
   image and scanned-PDF documents go through the production paths:
   `extractText`/OCR -> `KbDocumentModel.create` -> `chunkAndStoreDocument` ->
   `embeddingService.processDocument`.
4. For keyword/hybrid/context-expansion checks, refreshes BM25 statistics through `KbChunkModel.refreshBm25Stats`, proves
   whether `queryService` will use BM25 or its `ts_rank` fallback, then runs each
   applicable golden query through `queryService.query`.
5. Scores selected golden scenarios with recall@k, hit@k, MRR and evidence@k, while recording the real query
   plan, reranker outcome and context-expansion behavior observed inside the
   product path.
6. Deletes the fixture documents, connector and knowledge base through models,
   then refreshes BM25 statistics again so no evaluation terms remain in the
   derived cache.

When selected, the two BM25 refreshes scan the installation's real corpus. The real provider
calls can incur cost, especially when an LLM reranker also enables query
expansion and contextual retrieval. This is why the command is intended for a
platform administrator with pod access and access to the cluster logs.

Pass `--keep-fixture` only when an administrator needs to inspect the generated
KB. The report prints the KB and connector IDs; they must be removed manually
afterward. An interrupted process can also leave an object whose name starts
with `__kb-eval-`.

## Component matrix

Every golden row declares the product capabilities it exercises. A row runs
only when all of them are active; otherwise the artifact preserves it as a skip
with the exact disabled or unavailable reason.

| Component | Mode | How the runner proves it |
|---|---|---|
| Chunking | Offline | Sends a guaranteed multi-chunk document through the production splitter and checks the stored chunks. |
| Text embedding | Uses provider | Ingests and queries fixed text with the configured provider/model/dimension. |
| Image embedding | Uses provider | Ingests a real PNG, verifies its media chunk received an embedding, then runs text-to-image retrieval. |
| Keyword ranking | Offline | Rebuilds real BM25 statistics and runs term-saturation and length-normalization queries through the PostgreSQL keyword path. |
| Hybrid retrieval | Uses provider | Runs vector and keyword lanes plus reciprocal-rank fusion, with optional downstream stages isolated off. |
| Reranking | Uses provider | Requires a successful chat-model or native cross-encoder rerank call, with query expansion isolated off. |
| Query expansion | Uses provider | Requires additional semantic/keyword queries, with reranking isolated off. |
| Contextual retrieval | Uses provider | Requires a real stored contextual header produced at ingest, then queries the contextualized document. |
| Context expansion | Offline | Uses a guaranteed multi-chunk fixture and proves the returned hit includes neighboring chunks. |
| Document OCR | Uses provider | Sends an image-only PDF through OCR, embeds the transcription, and retrieves it. |

Artifacts store the selected components and a fingerprint of each component's
effective settings/model/credential. The next UI load compares those
fingerprints to the latest terminal run that selected each component. Comparison
aggregates are recomputed over paired golden queries only; unselected components
and scenarios are reported as coverage differences, never as regressions. The
keyword path also records a custom BM25 score gap between the expected document
and highest-scoring alternative. This comparison value can show that k1 or b
changed keyword scores while Hit@k and MRR stayed unchanged. It does not affect
pass or fail.

A configured-but-unresolvable credential is `unavailable`, not `disabled`. A
cross-encoder is valid for reranking but cannot generate query expansions or
contextual headers, so those scenarios are skipped with that explanation. An
embedding model without a declared image modality skips the image scenario.
An absent OCR pair skips only OCR. With hybrid search disabled, keyword and
BM25 scenarios are skipped while vector scenarios still run.

## Methodology and provenance

The current suite contains 24 synthetic corpus rows and 20 hand-authored golden
queries. Every row in `fixtures/golden.jsonl` declares `source: "hand"`. The
schema supports synthesized and user-log provenance, but no shipped row uses
either source. The bundled PNG and PDF are test assets; their creation source is
not recorded in the fixture manifest.

`fixtures/manifest.json` records the suite purpose, policy version, counts,
relevance scale, annotation status, and known limitations. A fixture test keeps
its counts aligned with the JSONL files.

The suite follows the standard information-retrieval test-collection pattern:
a fixed corpus, fixed queries, and expected document judgments. The judgments
themselves are Archestra-specific and have not been independently annotated.
They isolate product stages rather than represent a customer's query
distribution.

The metric mix is explicit:

- Hit@k, Recall@k, and MRR are standard ranked-retrieval measures. Here, k counts
  returned chunks. MRR uses the first expected chunk rank.
- Precision@k, nDCG@k, and MAP@k are document-level measures. Repeated chunks
  collapse to the first occurrence of their logical document before scoring.
- Graded judgments use 0 for explicit negatives and 1 through 3 for increasing
  relevance. Forbidden-result hit rate is a hard-negative diagnostic; pass/fail
  fixtures can also use it as a gate.
  The synthetic corpus is treated as fully judged; ungraded documents count as
  non-relevant for these built-in scenarios.
- Evidence@k is an Archestra-specific normalized substring check. It validates
  fixture evidence presence, not semantic relevance or entailment.
- Stage contracts and component pass/fail are Archestra-specific integration
  gates. A query passes when Recall@`expectAtK` is 1, declared evidence is
  present, and every required stage contract passes.
- The BM25 score gap is a custom tuning value. It subtracts the
  highest-scoring non-expected keyword result from the highest-scoring expected
  result. It is not a standard IR effectiveness metric and has no portable
  threshold.

Model-sensitive scenarios can declare `gateMode: "metric-only"`. They contribute
metrics and segments without degrading a run. The forced-retrieval no-answer
scenario is metric-only because the query service has no abstention threshold.

Artifacts include category, language, and difficulty macro segments plus
deterministic query-bootstrap 95% intervals for headline metrics. These intervals
quantify variation inside the synthetic suite; they do not make it representative
of production traffic.

Comparisons bootstrap paired per-query deltas over shared IDs and report the
delta interval plus the fraction of draws above zero. Metric-only cases contribute
to aggregates but never create a pass/fail query regression.

Hit@k, Recall@k, MRR, and the fixed-judgment pattern are established in
[ranked retrieval evaluation](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html)
and TREC-style qrels. BM25 and its k1/b parameters follow
[Robertson and Zaragoza](https://doi.org/10.1561/1500000019). The fixture data,
evidence checks, stage contracts, and score gap are not academic standards.

Aggregates are macro-averages over applicable, non-skipped queries. Comparisons
pair identical query IDs. Corpus or golden digest changes make a previous
baseline non-comparable even though the diff can still render shared IDs.
Matching digests do not remove model nondeterminism or installation-specific
BM25 statistics.

This suite is a deterministic regression and integration aid. Twenty
hand-authored queries cannot establish statistical significance, broad search
quality, or a universal release threshold. Production validation requires a
separate representative and human-reviewed evaluation set.

## Fixed fixtures

- `fixtures/corpus.jsonl`: compact, synthetic documents designed to isolate the
  stages above. It includes references to committed base64 PNG/PDF assets under
  `fixtures/assets`.
- `fixtures/golden.jsonl`: one query per line, including required capabilities,
  expected logical document IDs, optional verbatim evidence and the expectation
  rank.

Adding a scenario means adding a corpus row and a golden row. Loader tests fail
if IDs collide, a query can run while its expected document is unavailable, an
asset escapes the fixture directory, or expected evidence is absent from the
fixed source.

## Tilt development cluster

Tilt builds the same compiled backend entrypoint into a dedicated development
runner pod. The `kb-eval` resource executes it with `kubectl exec`, pointing at
the Kind cluster's PostgreSQL service and the development instance's stored
Knowledge settings. `--organization-id auto` is allowed there because the
standard development database has one organization; production commands should
always pass an explicit UUID.

Exit codes: `0` complete, `1` applicable scenarios missed an expectation or a
stage degraded, `2` blocked/setup/usage error. The JSON artifact is written
before a non-zero quality result is returned.
