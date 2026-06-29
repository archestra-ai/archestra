/**
 * Cascade-reinstall behavior contract.
 *
 * Each scenario captures: given a catalog of `shape`, when the user
 * performs `edit`, the system MUST follow the cascade path described
 * by `expected`. The scenarios ARE the spec — they're the single
 * source of truth that crosses layers.
 *
 * Consumers (each layer asserts its own slice of the contract):
 *   1. `shared/cascade-scenarios.test.ts` — sweeps every scenario
 *      through the shared `isMetadataOnlyEdit` predicate. Catches
 *      contradictions in the predicate's algebra.
 *   2. `backend/src/services/mcp-reinstall.test.ts` — should sweep
 *      scenarios through `requiresNewUserInputForReinstall` and the
 *      cascade gate; this is the AUTHORITATIVE behavior the backend
 *      ultimately enacts.
 *   3. `frontend/.../mcp-catalog-form.test.tsx` — should render the
 *      form with the fixture's shape, apply the scenario edit via
 *      simulated user input, and assert the inline confirm bar's
 *      presence/mode matches `expected`.
 *   4. `e2e-tests/.../mcp-edit-cascade.spec.ts` — end-to-end check
 *      that backend + frontend agree against a live install.
 *
 * **Adding a scenario**
 *   1. Pick a `shape` from `CATALOG_SHAPES` (or add a new one to
 *      `catalog-shape-fixtures.ts` if no existing shape exercises the
 *      dimension you need).
 *   2. Express `edit` as a function `(base) => mutated`. The provided
 *      helpers (`setDescription`, `addEnvVar`, `replaceCommand`, …)
 *      cover common edits and keep call sites readable.
 *   3. Set `expected` to the cascade outcome admins should observe.
 *   4. WRITE A `rationale` — the test name shows the action, the
 *      rationale answers "why is this the right behavior?". When a
 *      test fails, the rationale tells the reviewer whether the
 *      expectation should change or the code should change.
 *   5. Add `ref` linking the bug/PR that motivated the scenario,
 *      especially for regression cases.
 *
 * **When the layers disagree (known divergences)**
 *   The default `expected` describes the user-perceptible outcome.
 *   When current implementation diverges from intent — e.g. backend
 *   still cascades for a case the frontend correctly hides — record
 *   the divergence via `knownBackendOverride` / `knownFrontendOverride`.
 *   These act as `it.skip`-style markers that keep the scenario in the
 *   spec while letting tests pass; remove the override the moment the
 *   underlying code is fixed.
 */

import type {
  CatalogShapeFixture,
  CatalogShapeId,
} from "./catalog-shape-fixtures";

/** Cascade-reinstall outcomes the system can produce. */
export type CascadeOutcome =
  /** No cascade. Install row untouched. Bar not shown. */
  | "skip"
  /** Backend marks `reinstallRequired: true`. Install keeps running on
   *  old config. Bar shows "Reinstall required" / "Save and mark for
   *  reinstall". */
  | "manual"
  /** Backend immediately restarts pods. Bar shows "Servers will
   *  reinstall" / "Save and reinstall". */
  | "auto";

/** What the shared `isMetadataOnlyEdit` predicate should return for
 *  this scenario, given that it only inspects diffs between two
 *  catalog shapes. */
export type SharedPredicateExpectation =
  | "metadata-only-diff" // predicate returns true (description-only edit)
  | "non-metadata-diff" // predicate returns false (other diff found)
  | "no-diff"; // predicate returns false (nothing differs)

export interface CascadeScenario {
  /** Stable kebab-case id used as the parameterized test name and
   *  as a cross-reference in bug reports / commit messages. */
  id: string;
  /** Which fixture from `CATALOG_SHAPES` to use as the baseline. */
  shape: CatalogShapeId;
  /** Plain-English summary of what the admin did. Shows up as the
   *  test name in `test.each(...)` output. */
  userAction: string;
  /** How to mutate the fixture. Use the helpers below. */
  edit: (base: CatalogShapeFixture) => CatalogShapeFixture;
  /** The cascade outcome the system MUST follow when this edit is
   *  saved on a catalog with at least one install. */
  expected: CascadeOutcome;
  /** What `isMetadataOnlyEdit` should return. Required so reviewers
   *  always reason about the predicate's contract for each scenario;
   *  the shared baseline test asserts against this. */
  sharedPredicate: SharedPredicateExpectation;
  /** WHY this outcome is correct. Required. */
  rationale: string;
  /** Bug/PR ref. Especially for regression scenarios. */
  ref?: string;
  /** Override `expected` for the backend assertion only — use when a
   *  known backend gap diverges from intent. Remove once fixed. */
  knownBackendOverride?: {
    actual: CascadeOutcome;
    issue: string;
  };
  /** Override `expected` for the frontend bar assertion only. */
  knownFrontendOverride?: {
    actual: CascadeOutcome;
    issue: string;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Edit helpers — keep scenario `edit` callsites readable.
// ─────────────────────────────────────────────────────────────────────

type EnvVar = NonNullable<
  NonNullable<CatalogShapeFixture["localConfig"]>["environment"]
>[number];

export const setDescription =
  (next: string) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    description: next,
  });

export const replaceCommand =
  (next: string) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    localConfig: {
      ...(base.localConfig ?? {}),
      command: next,
    },
  });

export const replaceDockerImage =
  (next: string) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    localConfig: {
      ...(base.localConfig ?? {}),
      dockerImage: next,
    },
  });

export const addEnvVar =
  (v: EnvVar) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    localConfig: {
      ...(base.localConfig ?? {}),
      environment: [...(base.localConfig?.environment ?? []), v],
    },
  });

export const removeEnvVar =
  (key: string) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    localConfig: {
      ...(base.localConfig ?? {}),
      environment: (base.localConfig?.environment ?? []).filter(
        (e) => e.key !== key,
      ),
    },
  });

export const modifyEnvVar =
  (key: string, patch: Partial<EnvVar>) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    localConfig: {
      ...(base.localConfig ?? {}),
      environment: (base.localConfig?.environment ?? []).map((e) =>
        e.key === key ? { ...e, ...patch } : e,
      ),
    },
  });

export const setLabels =
  (labels: Array<{ key: string; value: string }>) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    labels,
  });

type UserConfigField = {
  type?: string;
  title?: string;
  description?: string;
  promptOnInstallation?: boolean;
  required?: boolean;
  sensitive?: boolean;
  headerName?: string;
  default?: unknown;
};

export const addUserConfigField =
  (key: string, field: UserConfigField) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    userConfig: { ...(base.userConfig ?? {}), [key]: field },
  });

export const removeUserConfigField =
  (key: string) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => {
    const { [key]: _drop, ...rest } = (base.userConfig ?? {}) as Record<
      string,
      unknown
    >;
    return { ...base, userConfig: rest };
  };

export const modifyUserConfigField =
  (key: string, patch: Partial<UserConfigField>) =>
  (base: CatalogShapeFixture): CatalogShapeFixture => ({
    ...base,
    userConfig: {
      ...(base.userConfig ?? {}),
      [key]: {
        ...((base.userConfig?.[key] as Record<string, unknown> | undefined) ??
          {}),
        ...patch,
      },
    },
  });

const noChange = (base: CatalogShapeFixture): CatalogShapeFixture => ({
  ...base,
});

// ─────────────────────────────────────────────────────────────────────
// The scenarios.
// ─────────────────────────────────────────────────────────────────────

export const CASCADE_SCENARIOS: CascadeScenario[] = [
  // ── description-only across all shapes (the headline path) ─────────
  {
    id: "desc-only-clean-local",
    shape: "envprobeCleanLocal",
    userAction: "Admin edits description on a clean local catalog",
    edit: setDescription("rewritten description"),
    expected: "skip",
    sharedPredicate: "metadata-only-diff",
    rationale:
      "`description` is in METADATA_ONLY_CATALOG_FIELDS. No runtime field changed. Install keeps running on its current config.",
  },
  {
    id: "labels-only-clean-local",
    shape: "envprobeCleanLocal",
    userAction: "Admin edits labels on a clean local catalog",
    edit: setLabels([
      { key: "team", value: "platform" },
      { key: "env", value: "prod" },
    ]),
    expected: "skip",
    sharedPredicate: "metadata-only-diff",
    rationale:
      "`labels` is in METADATA_ONLY_CATALOG_FIELDS. Labels live in a separate junction table (`mcp_catalog_labels`) and never get propagated to the pod spec, env vars, headers, image, command, or any other runtime concern. Pure organizational metadata — install keeps running on its current config.",
  },
  {
    id: "desc-only-docker-only-streamable-http",
    shape: "hdrprobeDockerOnly",
    userAction:
      "Admin edits description on a docker-image-only catalog (no command/arguments)",
    edit: setDescription("rewritten description"),
    expected: "skip",
    sharedPredicate: "metadata-only-diff",
    rationale:
      "Same as the clean-local case, but on a shape that triggered a transformFormToApiData round-trip asymmetry: the form used to add empty `command`/`arguments` defaults, which made the predicate's JSON-stringify diff flag `localConfig` as a runtime change. Now caught at the form layer via react-hook-form's dirtyFields.",
    ref: "PR fix/consolidate-catalog-edit-confirm-dialogs",
  },
  {
    id: "desc-only-bag-catalog-local",
    shape: "sqlOneBagLocal",
    userAction:
      "Admin edits description on a local catalog with a populated secret bag",
    edit: setDescription("rewritten description"),
    expected: "skip",
    sharedPredicate: "metadata-only-diff",
    rationale:
      "Regression: backend used to fetch `originalCatalogItem` with `expandSecrets: true`, then compare against `Model.update`'s raw return. For bag-bearing rows the expanded plaintext-vs-stored-ID asymmetry tripped `localConfig.environment[*].value`. Fixed by fetching a second `expandSecrets: false` copy solely for the cascade gate.",
    ref: "PR fix/consolidate-catalog-edit-confirm-dialogs",
  },
  {
    id: "desc-only-bag-catalog-remote",
    shape: "test1RemoteOAuthBag",
    userAction:
      "Admin edits description on a remote OAuth catalog with a populated client secret bag",
    edit: setDescription("rewritten description"),
    expected: "skip",
    sharedPredicate: "metadata-only-diff",
    rationale:
      "Mirror of the local-bag case for remote OAuth catalogs. Same backend symmetric-fetch fix applies.",
  },
  {
    id: "desc-only-multitenant",
    shape: "multitenantLocalShared",
    userAction: "Admin edits description on a multitenant local catalog",
    edit: setDescription("rewritten description"),
    expected: "skip",
    sharedPredicate: "metadata-only-diff",
    rationale:
      "Multitenancy is orthogonal to whether a metadata-only edit cascades. Bar copy variant would say 'shared deployment' instead of 'N installs' if cascade WERE needed, but for desc-only there's nothing to show.",
  },

  // ── runtime field changes (cascade SHOULD fire) ────────────────────
  {
    id: "command-change-local",
    shape: "envprobeCleanLocal",
    userAction: "Admin changes localConfig.command from 'sh' to 'bash'",
    edit: replaceCommand("bash"),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Command is a runtime field (covered by backend `localExecutionConfigChanged`). Existing pods would be running the wrong binary until they reinstall — mark for manual reinstall so the owner is in control.",
  },
  {
    id: "docker-image-change",
    shape: "hdrprobeDockerOnly",
    userAction: "Admin bumps dockerImage tag",
    edit: replaceDockerImage("mendhak/http-https-echo:31"),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "dockerImage is a runtime field. Pods on the old tag must reinstall to pick up the new image.",
  },

  // ── env var schema evolution (the optional-vs-required distinction) ─
  {
    id: "add-optional-prompted-env-var",
    shape: "promptedEnvLocal",
    userAction:
      "Admin adds a new prompted-on-installation env var, marked optional",
    edit: addEnvVar({
      key: "NEW_OPTIONAL_PROMPT",
      type: "plain_text",
      promptOnInstallation: true,
      required: false,
    }),
    expected: "skip",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Schema-evolution: existing installs without the new optional var are still valid. They can adopt it on the next manual reinstall but shouldn't be force-flagged. The shared predicate sees a localConfig diff and returns false, but the backend's `promptedEnvVarsChanged` and the frontend's `envChangeRequiresReinstall` both correctly classify this as forward-compatible.",
    ref: "User-reported bug; PR fix/consolidate-catalog-edit-confirm-dialogs",
  },
  {
    id: "add-required-prompted-env-var",
    shape: "promptedEnvLocal",
    userAction:
      "Admin adds a new prompted-on-installation env var, marked required",
    edit: addEnvVar({
      key: "NEW_REQUIRED_PROMPT",
      type: "secret",
      promptOnInstallation: true,
      required: true,
    }),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Existing installs are missing a now-required value. They need to be re-prompted before they're valid again — mark for manual reinstall.",
  },
  {
    id: "remove-prompted-env-var",
    shape: "promptedEnvLocal",
    userAction: "Admin removes an existing prompted env var",
    edit: removeEnvVar("EXISTING_OPTIONAL_PROMPT"),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Existing installs hold a stored value for a var the catalog no longer accepts. Reinstall to clean up.",
  },
  {
    id: "promote-env-var-to-required",
    shape: "promptedEnvLocal",
    userAction:
      "Admin flips an existing prompted env var from optional → required",
    edit: modifyEnvVar("EXISTING_OPTIONAL_PROMPT", { required: true }),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "An installer that left the optional var blank is now missing a required value. Re-prompt.",
  },
  {
    id: "demote-env-var-to-optional",
    shape: "promptedEnvLocal",
    userAction:
      "Admin flips an existing prompted env var from required → optional",
    edit: modifyEnvVar("EXISTING_REQUIRED_PROMPT", { required: false }),
    expected: "skip",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Installs that filled the required var are still valid; the var is just no longer mandatory. Forward-compatible change.",
  },
  {
    id: "flip-env-var-mounted",
    shape: "promptedEnvLocal",
    userAction:
      "Admin flips a prompted secret env var's mounted layout (env var ↔ mounted file)",
    edit: modifyEnvVar("EXISTING_REQUIRED_PROMPT", { mounted: true }),
    expected: "auto",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Toggling `mounted` swaps the pod spec between an env var injection and a mounted secret file at `/secrets/<key>`. The user supplied the same value at install time; no re-prompt needed. But pods still have to restart to pick up the new layout. Caught by `promptedEnvVarsRuntimeChanged` (separate from the lenient `promptedEnvVarsChanged` schema check).",
  },
  {
    id: "change-env-var-type",
    shape: "promptedEnvLocal",
    userAction: "Admin changes an env var's type from plain_text to secret",
    edit: modifyEnvVar("EXISTING_OPTIONAL_PROMPT", { type: "secret" }),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Type change moves the stored value to a different storage bucket (e.g., secret bag). Existing values may not be addressable post-change. Re-prompt.",
  },

  // ── userConfig / header schema evolution (parallel to env-var rules)
  {
    id: "add-optional-header",
    shape: "sqlOneBagLocal",
    userAction:
      "Admin adds a new per-installation header via Add Header, marked optional",
    edit: addUserConfigField("new_optional_header", {
      type: "string",
      title: "x-new-optional",
      description: "",
      headerName: "x-new-optional",
      promptOnInstallation: true,
      required: false,
      sensitive: false,
    }),
    expected: "skip",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Same schema-evolution rules as env vars: an optional userConfig field added to the catalog template doesn't invalidate existing installs (they simply don't fill it). Fixed via `userConfigChangedBreakingly` in the backend gate + `additionalHeadersChangeRequiresReinstall` on the frontend.",
    ref: "User-reported via PW screenshot (round 3)",
  },
  {
    id: "add-required-header",
    shape: "sqlOneBagLocal",
    userAction: "Admin adds a new per-installation header, marked required",
    edit: addUserConfigField("new_required_header", {
      type: "string",
      title: "x-new-required",
      description: "",
      headerName: "x-new-required",
      promptOnInstallation: true,
      required: true,
      sensitive: false,
    }),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Existing installs are missing a now-required value. Re-prompt is needed before the install will function.",
  },
  {
    id: "remove-optional-header",
    shape: "sqlOneBagLocal",
    userAction: "Admin removes an existing OPTIONAL header field",
    edit: removeUserConfigField("header_x_db_url"),
    expected: "auto",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Backend's `userConfigChangedBreakingly` flags any removal as breaking (not forward-compatible), but `requiredUserConfigChanged` only fires manual reinstall for REQUIRED field removal. So an optional removal falls through to AUTO restart — pods restart, but the user isn't re-prompted because there's nothing to fill. This is asymmetric with env-var removal (which is always 'manual' via `promptedEnvVarsChanged`); the inconsistency is documented and could be unified in a follow-up.",
  },
  {
    id: "promote-header-to-required",
    shape: "sqlOneBagLocal",
    userAction: "Admin flips an existing header from optional → required",
    edit: modifyUserConfigField("header_x_db_url", { required: true }),
    expected: "manual",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "An installer that didn't fill the previously-optional value is now invalid. Re-prompt.",
  },
  {
    id: "demote-header-to-optional",
    shape: "sqlOneBagLocal",
    userAction: "Admin flips a required header back to optional",
    edit: modifyUserConfigField("header_x_required_token", { required: false }),
    expected: "skip",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "The install already supplied a value when the header was required; that value remains valid after demotion. `requiredUserConfigChanged` deliberately does not fire on demotion (mirror of `demote-env-var-to-optional` for the header surface). No re-prompt, no pod restart.",
  },
  {
    id: "change-header-name",
    shape: "sqlOneBagLocal",
    userAction: "Admin changes the wire header name (e.g. x-foo → x-bar)",
    edit: modifyUserConfigField("header_x_db_url", { headerName: "x-renamed" }),
    expected: "auto",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "Header routing changed. The pod and gateway need to be in sync on which header carries the value; reinstall realigns them.",
  },
  {
    id: "change-static-header-value",
    shape: "hdrprobeDockerOnly",
    userAction: "Admin edits a static header's value (no install prompt)",
    edit: modifyUserConfigField("header_x_static_token", {
      default: "rotated-token-value",
    }),
    expected: "auto",
    sharedPredicate: "non-metadata-diff",
    rationale:
      "For a static header-mapped userConfig entry (no install prompt), the form writes the admin's value into `userConfig[field].default` — that IS the runtime header sent on the wire. Changing it means installs would keep sending the old value until pods restart. The auto path is correct (no re-prompt needed; admin already provided the value). Caught by `userConfigChangedBreakingly` on both sides. Distinct from prompted headers where `default` is just a placeholder.",
  },

  // ── identity / nothing-changed sanity ─────────────────────────────
  {
    id: "no-change-at-all",
    shape: "envprobeCleanLocal",
    userAction: "Admin opens edit dialog and clicks Save with no edits",
    edit: noChange,
    expected: "skip",
    sharedPredicate: "no-diff",
    rationale:
      "Idempotent save. Predicate returns false (contract: 'true means there IS a metadata-only diff worth skipping for'). No cascade should fire.",
  },
];

/**
 * Group scenarios by their expected outcome for inspection / reporting.
 */
export function groupScenariosByExpected(): Record<
  CascadeOutcome,
  CascadeScenario[]
> {
  const groups: Record<CascadeOutcome, CascadeScenario[]> = {
    skip: [],
    auto: [],
    manual: [],
  };
  for (const s of CASCADE_SCENARIOS) groups[s.expected].push(s);
  return groups;
}
