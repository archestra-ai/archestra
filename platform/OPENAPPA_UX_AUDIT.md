# OpenAPPA setup and usage UX audit

Reviewed the local OpenAPPA UI on 2026-09-22 against branch `review/openappa-ux-audit` at `eef5600b2b`. Browser checks were read-only or used unsaved form drafts. No deployment setting, policy revision, GitHub source, battery, or database row was changed.

## P1 — Policy drafts disappear during ordinary in-app navigation

**Repro:** Open `/openappa`, change the TOML, then click **Plugins** or **Guardrails** in the sidebar. The app navigates without asking. Return to `/openappa`: the editor is back at the saved policy, and the draft is gone.

**Why it happens:** `guardrails-policy-editor.tsx` registers only `beforeunload`. Next.js client-side links do not unload the page. The shared `useGuardedInAppNavigation` hook exists but is not used here.

**Fix:** Guard in-app navigation while the policy form is dirty, including sidebar links and browser Back. Offer **Keep editing** / **Discard changes**. Add a browser-level regression test using a real route transition. Preserve the draft when an API conflict occurs.

## P1 — A deployment-wide switch can turn on a permissive starter policy

**Repro:** On a fresh OpenAPPA page, the switch is above the policy editor and is independently enabled. The editor says **Not yet saved** and shows a catch-all `noop` policy. The switch text says it applies APPA policies to every agent in the deployment, but offers no warning that this initial policy adds no restrictions.

**Evidence:** `backend/src/services/guardrails-policy.ts` returns `INITIAL_POLICY` when no saved revision exists. That policy gives `*` tools the `noop` annotator. `guardrails-deployment.routes.ts` saves the global enabled flag without checking for a saved or restrictive policy. The page has no readiness summary or test decision flow.

**Fix:** Make the initial state explicit: **No custom APPA restrictions configured**. Before enabling deployment-wide enforcement, summarize the exact effective policy, batteries, scope, and existing guardrails behavior. Provide a sample policy and a way to test a tool call/result against the draft. If enabling the permissive default is intended, require an explicit acknowledgement in the UI.

## P2 — GitHub source edits are discarded without warning

**Repro:** Click **Connect GitHub**, enter a repository, then click **Cancel**. The dialog closes immediately. Reopening it shows a blank repository field.

**Why it happens:** `SourceForm` has form state, but does not pass `form.formState.isDirty` to `StandardFormDialog`'s `isDirty` prop. The shared dialog already supports a discard confirmation.

**Fix:** Wire `isDirty` through the dialog and test Cancel, Escape, close button, and outside-click. Do the same for the battery upload dialog after a name or folder is selected.

## P2 — The migration path is unclear across two guardrails surfaces

**Repro:** Studio shows **Guardrails** and **OpenAPPA** as peer sidebar entries. The former still offers editable per-tool call and result controls; the latter says both engines can be active. The OpenAPPA page does not link to the legacy controls, explain evaluation order, identify which rules will affect a sample tool, or say how to migrate an existing rule.

**Impact:** An administrator replacing old guardrails cannot tell whether a policy in one surface supersedes, combines with, or is independent of the other. The GitHub sync and battery concepts add more policy sources without an effective-policy preview on this page.

**Fix:** Add a migration/readiness panel with the current engines, effective policy sources, precedence, and a direct route to the legacy rules. Make the dual-engine period and eventual migration state explicit in UI and docs.

## P3 — Validation is separated from the action it should gate

**Repro:** Enter malformed TOML and press **Validate**. An error appears below the tall editor, while **Save & apply** stays enabled. The backend rejects invalid saves, but users can still take an action known to fail and may miss the error below the fold.

**Fix:** Disable save for a draft that has failed validation, or make save run validation and focus/scroll to the first error. Show an error count beside the editor controls and mark the relevant line when available.

## P3 — First-time paths end without a next step

- The empty **Batteries** panel lists provider names and says to add an MCP server, but has no link to MCP Registry, explanation of what a particular battery enforces, or indicator that deployment enforcement is currently off.
- **Upload package** asks for a folder containing a manifest, policy, and helpers, but gives no schema, sample, or documentation link. Its form accepts a name and folder without a client-side preview of the files that will be uploaded.
- The **OpenAPPA** plugin install command is found under Plugins and installs a Claude Code integration. The policy page does not explain whether that client plugin is required for proxy enforcement, and the plugin page does not link back to policy setup.

## Suggested priority

1. Prevent policy draft loss and add a regression test.
2. Add a safe first-run readiness/activation flow around the global switch.
3. Show effective policy and the relationship to existing guardrails.
4. Guard setup dialogs and make validation feedback actionable.
5. Add direct links, examples, and battery/package previews.

## Scope limit

I did not toggle deployment enforcement, save a policy, connect a repository, upload a package, or install a plugin on the shared local stack. This pass establishes UI behavior and code paths for those actions; it does not verify end-to-end enforcement or battery execution.
