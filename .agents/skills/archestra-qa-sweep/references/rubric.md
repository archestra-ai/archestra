# Findings, repros, and rubrics

## Finding layout

Each finding is a directory `<run>/findings/<ID>/`. The ID is `<LANE>-<NN>`, and the lane code is assigned by the orchestrator.

| File | Written by | Content |
|---|---|---|
| `finding.json` | explorer | the claim (schema below) |
| `repro.mjs` | explorer | executable check that returns `reproduced: true` while the bug exists |
| `shots/*.png` | explorer | evidence from exploration |
| `gate.json` | `repro.mjs` gate | `reproduced` / `not-reproduced` / `flaky` / `error` / `no-repro` |
| `verdict.json` | verifier | judgment (schema below) |
| `verify-shots/*.png` | verifier | fresh evidence |

### finding.json

```json
{
  "id": "LANE-01",
  "area": "llm",
  "route": "/llm/logs?source=chat",
  "links": ["/llm/logs"],
  "role": "admin",
  "variant": "light-1440",
  "category": "data-integrity",
  "severity": "major",
  "title": "Source filter hides sessions whose newest row has another source",
  "steps": ["open /llm/logs", "pick Source = Chat", "compare with the unfiltered list"],
  "expected": "All sessions containing a chat interaction are listed",
  "actual": "3 of 7 such sessions are listed; ?source=api returns none",
  "angle": "cross-page consistency"
}
```

The fields take these values:
- **category:** `security`, `data-integrity`, `validation`, `error-handling`, `state`, `permissions`, `copy`, `layout`, `a11y`, `performance` or `other`.
- **severity:** the explorer's estimate; the verifier sets the final value.
- **role:** a key from `manifest.roles`, or `anonymous`.
- **variant:** a key from `VARIANTS` in `scripts/lib.mjs`.

### repro.mjs contract

```js
export const meta = { role: "admin", variant: "light-1440" };

export default async function repro({ page, api, apiUrl, baseUrl, prefix, shot, events }) {
  // `page` already has the role's session; `api` is page.request (same cookies).
  // Create entities named `${prefix}...` only, and delete them in a finally block.
  await page.goto("/llm/logs?source=chat");
  await shot("filtered");
  const rows = await page.getByRole("row").count();
  return { reproduced: rows < 8, observed: `${rows - 1} sessions listed` };
}
```

Rules for a repro:
- **Return value:** return `reproduced: true` only when the defect is observed. Return `false` when the app behaves as expected. Throw on setup failure; that counts as `error`, not `not-reproduced`.
- **Assert behaviour, not wording.** Status codes, counts, stored values, element geometry and presence of raw internals (e.g. `/Failed query|insert into/`) are fine. Exact prose is not, unless the bug *is* the prose.
- **Self-contained and idempotent:** seed what you need, then clean up. The gate runs every repro twice in fresh contexts. Known regressions replay against future versions.
- **API-level bugs:** use `api.get/post(...)` against `apiUrl`. They still need a UI-facing consequence or a security impact to rate above polish.

### verdict.json

```json
{
  "verdict": "CONFIRMED",
  "severity": "major",
  "severityReason": "wrong data in a primary admin view; no workaround besides unfiltered list",
  "correctedActual": null,
  "evidence": "repro gate reproduced 2/2; also reproduces for member role",
  "rootCause": { "file": "platform/backend/src/models/interaction.ts", "line": 1593, "explanation": "row-level filter + session head = newest row" },
  "fixDirection": "filter sessions by EXISTS on source, not by head row",
  "duplicateOf": null,
  "security": false,
  "reproReview": "repro asserts row count on the filtered list — valid"
}
```

The `verdict` field takes one of these values:
- `CONFIRMED`
- `CONFIRMED-DIFFERENT`: real, but the claim was wrong. Put the corrected claim in `correctedActual`.
- `NOT-REPRODUCED`
- `INTENDED`: requires a `rootCause.file` citing the code or docs that make it deliberate.
- `FIXED-ON-MAIN`: requires a citation.
- `INVALID-REPRO`: the repro proves nothing and the verifier could not write a valid one.

## Severity rubric

Rate the user and operator impact, not how surprising the bug is.

| Severity | Meaning | Anchors from past runs |
|---|---|---|
| **blocker** | Security boundary broken, data loss or corruption, or the core flow cannot be completed by anyone | a low-privilege role gains admin rights; deleting X silently deletes Y |
| **major** | Wrong data shown or stored in a primary view, internals leaked (SQL, stack traces, k8s objects, other users' data), or a user is stuck with no path forward | a stack trace or query text in an error toast; a filter that hides matching rows; buttons that silently do nothing for a role |
| **minor** | Missing validation that stores bad data; a misleading error ("check your internet" on a 403); a secondary flow broken; layout broken at a supported width | port 99999 accepted; `[object Object]` tool error; Clone drops a setting |
| **polish** | Copy, naming or terminology drift, cosmetic layout, a missing empty state or hint | "Share" opens "Chat permissions"; inconsistent tab titles |

Adjustments:
- **Down one level:** admin-only and recoverable; or whole-number input "by design" where only the hint or validation is missing; or the issue appears only at 400px on a desktop-first admin page.
- **Up one level:** reachable by low-privilege roles; affects money or limits enforcement; corrupts data that other features read.

## False-positive traps

All of these happened in real runs. Explorers must avoid them, and verifiers must check for them.

| Trap | How to avoid |
|---|---|
| Viewport simulated in an iframe or by CSS | Only the `VARIANTS` from `lib.mjs` count; never judge layout from an iframe. |
| Dark mode faked by adding a `dark` class | Use the variant's `colorScheme`, or the app's own theme toggle. |
| Wrong keyboard modifier | Use `ControlOrMeta+K` in Playwright; Ctrl+K on a Mac is not a bug. |
| Dev-server compile lag ("page blank for 10s") | Reload once after warm-up. Report slowness only if it reproduces on a warm route. |
| Resource owned by another user returns 404/403 | Check ownership in the fixtures. Correct non-disclosure is not a bug. |
| Intended behaviour | Search the code for the deliberate branch before filing. Verifiers must cite the code for an INTENDED verdict. |
| Data created by other lanes or runs | Only reason about entities with your prefix, or counts you measured yourself in the same script. |
| Flaky shared state | Never share a browser or tab between agents; the scripts open isolated contexts. |
| Screenshot naming drift | Screenshots live inside the finding directory, so attribution is structural. |
