import { createHash } from "node:crypto";
import type {
  BatteryPackage as NativeBatteryPackage,
  PolicyEditInput,
} from "@archestra/openappa-rs";
import logger from "@/logging";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import { INITIAL_POLICY } from "@/services/guardrails-policy";
import type { BatteryInstall } from "@/types/openappa-batteries";
import { mapWithConcurrency } from "@/utils/concurrency";
import { catalogToolPrefixes } from "./batteries";
import {
  bundledEntry,
  openappaDeclarations,
  type PolicyResolution,
  uploadedEntry,
} from "./declarations";

/** What one run of the step left behind, by organization, for its caller to log. */
type DeclareInstallsSummary = {
  /** Organizations that received a migration-authored revision. */
  declared: string[];
  /** Organizations whose latest revision already declares what their rows serve. */
  unchanged: string[];
  /** Organizations still holding rows no declaration carries; the log names why. */
  failed: string[];
};

/**
 * Author the declarations the legacy `openappa_battery_installs` rows stand for.
 *
 * Composition now reads the organization's policy text, and every recompose
 * rewrites the install rows from it: a row the text does not declare is deleted
 * at the first recompose after the deploy. This step is what carries the legacy
 * rows into the text, so it runs once at startup before anything composes, and
 * as a standalone script for operators who migrate out of band. It is idempotent
 * — a second run finds the text already saying what the rows say and writes
 * nothing — and it never composes, recomposes or validates through the grant
 * gate: every binding it carries was created under `credential:update` already.
 *
 * Every row it cannot carry is logged, structured, before the first recompose
 * takes it: a disabled install, an install whose battery resolves to neither an
 * upload nor the bundle, a binding of a row that is not its battery's helper
 * owner, and a variable two owners bind to different keys.
 */
export async function declareExistingInstalls(): Promise<DeclareInstallsSummary> {
  const summary: DeclareInstallsSummary = {
    declared: [],
    unchanged: [],
    failed: [],
  };
  // Organizations do not wait on each other: each one is its own read-edit-save
  // under its own advisory lock, and startup holds everything else up.
  const organizationIds =
    await OpenAppaBatteryInstallModel.listOrganizationIds();
  const outcomes = await mapWithConcurrency(
    organizationIds,
    DECLARE_CONCURRENCY,
    declareOrganization,
  );
  outcomes.forEach((outcome, index) => {
    const organizationId = organizationIds[index] as string;
    if (outcome.status === "fulfilled") {
      summary[outcome.value].push(organizationId);
      return;
    }
    logger.error(
      { organizationId, err: outcome.reason },
      "Declaring an organization's OpenAPPA battery installs failed; its rows are still the only record of them",
    );
    summary.failed.push(organizationId);
  });
  return summary;
}

/** One read-edit-save, plus the two retries a lost revision race is allowed. */
const SAVE_ATTEMPTS = 3;

/** Organizations declared at once; the same bound a recompile fan-out uses. */
const DECLARE_CONCURRENCY = 4;

/** The variables a `[credentials]` table admits; the editor refuses the rest. */
const CREDENTIAL_VARIABLE = /^APPA_PROVIDER_[A-Z0-9_]+$/;

type Outcome = keyof DeclareInstallsSummary;

/** Why a row, or one of its bindings, is not carried into the declarations. */
type DroppedReason = "disabled" | "unresolved" | "not_helper_owner";

/** The edits one organization's rows imply, and the batteries they declare. */
type Plan = { edits: PolicyEditInput[]; batteries: string[] };

async function declareOrganization(organizationId: string): Promise<Outcome> {
  const rows = await OpenAppaBatteryInstallModel.list(organizationId);
  if (rows.length === 0) return "unchanged";
  const native = await import("@archestra/openappa-rs");
  let planned: Plan = { edits: [], batteries: [] };
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const latest = await latestRevision(organizationId);
    // What a row does not carry is lost once, not once per attempt.
    planned = await planFor({
      organizationId,
      rows,
      content: latest.content,
      log: attempt === 0,
    });
    if (planned.edits.length === 0) return "unchanged";
    const edited = await native.editOpenappaPolicy(
      latest.content,
      planned.edits,
    );
    const content = edited.content ?? null;
    if (content === null) {
      logger.error(
        { organizationId, edits: planned.edits, errors: edited.errors },
        "The declarations of an organization's OpenAPPA battery installs were refused by the editor",
      );
      return "failed";
    }
    // The editor is idempotent: a text that already says what the rows say comes
    // back byte for byte, which is what makes a second run of the step a no-op.
    if (content === latest.content) return "unchanged";
    const parsed = await native.parseOpenappaDeclarations(content);
    if (parsed.errors.length > 0) {
      logger.error(
        { organizationId, errors: parsed.errors },
        "The declarations authored for an organization's OpenAPPA battery installs do not parse; not saving them",
      );
      return "failed";
    }
    const saved = await GuardrailsPolicyModel.saveDeclarationMigration({
      organizationId,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      expectedRevision: latest.revision,
    });
    if (!saved) continue;
    logger.info(
      {
        organizationId,
        revision: saved.revision,
        batteries: planned.batteries,
      },
      "Declared the OpenAPPA battery installs of an organization in its policy",
    );
    return "declared";
  }
  logger.error(
    { organizationId, edits: planned.edits },
    "The policy kept changing under the OpenAPPA battery install declarations; its rows are still the only record of them",
  );
  return "failed";
}

/**
 * The edits that make the text declare what the enabled rows serve: one include
 * entry per battery, the catalogs' current tool prefixes merged into the alias of
 * every namespace the battery declares, and the credential variables the helper
 * owners agree on.
 */
async function planFor(params: {
  organizationId: string;
  rows: readonly BatteryInstall[];
  content: string;
  log: boolean;
}): Promise<Plan> {
  const { organizationId, rows, content, log } = params;
  const resolution = await openappaDeclarations.resolve({
    organizationId,
    content,
  });
  const prefixes = await catalogToolPrefixes(organizationId);
  const includes: PolicyEditInput[] = [];
  const batteries: string[] = [];
  /** Namespace → its alias targets, the declared ones first, in order. */
  const targets = new Map<string, string[]>();
  const owners: BatteryInstall[] = [];

  for (const row of rows)
    if (!row.enabled) drop({ organizationId, row, reason: "disabled", log });

  // `list` orders by `createdAt` then id, so the first enabled row of a battery
  // is the helper owner the bridge chose for it.
  for (const [name, batteryRows] of groupByBattery(
    rows.filter((row) => row.enabled),
  )) {
    const resolved = await resolveBattery({ organizationId, name });
    if (!resolved) {
      for (const row of batteryRows)
        drop({ organizationId, row, reason: "unresolved", log });
      continue;
    }
    batteries.push(name);
    // A battery is included once: every entry that already spells this battery
    // under another spelling goes, so the text never answers the name twice.
    for (const included of resolution.entries)
      if (included.name === name && included.entry !== resolved.entry)
        includes.push({ kind: "removeInclude", entry: included.entry });
    includes.push({ kind: "addInclude", entry: resolved.entry });
    owners.push(batteryRows[0]);
    for (const row of batteryRows.slice(1))
      if (Object.keys(row.credentialBindings).length > 0)
        drop({ organizationId, row, reason: "not_helper_owner", log });
    for (const row of batteryRows) {
      const carried = prefixes.byCatalog.get(row.catalogId);
      if (!carried || carried.size === 0) {
        if (log)
          logger.warn(
            { organizationId, battery: name, catalogId: row.catalogId },
            "An OpenAPPA battery install names a catalog carrying no tool prefix; the battery is declared with no alias for it",
          );
        continue;
      }
      for (const namespace of resolved.battery.namespaces)
        mergeTargets({ targets, resolution, namespace, carried });
    }
  }

  return {
    edits: [
      ...includes,
      ...[...targets].map(([namespace, servers]) => ({
        kind: "bindServers" as const,
        namespace,
        servers,
      })),
      ...credentialEdits({ organizationId, owners, log }),
    ],
    batteries,
  };
}

/**
 * The credential variables the step writes: one key per variable, agreed on by
 * every helper owner that binds it. A variable two owners bind to different keys
 * is left unbound — the batteries reading it show `missing_credentials` until an
 * operator binds one key in the panel — and never resolved by last writer.
 */
function credentialEdits(params: {
  organizationId: string;
  owners: readonly BatteryInstall[];
  log: boolean;
}): PolicyEditInput[] {
  const { organizationId, owners, log } = params;
  /** Variable → the key each owner binds it to → the batteries binding that key. */
  const bound = new Map<string, Map<string, string[]>>();
  for (const owner of owners)
    for (const [variable, key] of Object.entries(owner.credentialBindings)) {
      const keys = bound.get(variable) ?? new Map<string, string[]>();
      keys.set(key, [...(keys.get(key) ?? []), owner.batteryName]);
      bound.set(variable, keys);
    }
  const edits: PolicyEditInput[] = [];
  for (const [variable, keys] of bound) {
    if (!CREDENTIAL_VARIABLE.test(variable)) {
      if (log)
        logger.warn(
          { organizationId, variable, keys: [...keys.keys()] },
          "An OpenAPPA battery install binds a variable no credentials table admits; leaving it unbound",
        );
      continue;
    }
    if (keys.size > 1) {
      if (log)
        logger.warn(
          {
            organizationId,
            variable,
            bindings: [...keys].map(([key, batteries]) => ({
              key,
              batteries,
            })),
          },
          "OpenAPPA batteries bind one credential variable to different keys; leaving it unbound",
        );
      continue;
    }
    const [key] = [...keys.keys()];
    edits.push({ kind: "setCredential", variable, key });
  }
  return edits;
}

/**
 * The battery an install row serves and the entry that spells it: the newest
 * stored package of the name this deployment can still inspect, since an upload
 * shadowed the bundled battery under the rows this step reads, and the bundled
 * battery when no stored version answers.
 */
async function resolveBattery(params: {
  organizationId: string;
  name: string;
}): Promise<{ entry: string; battery: NativeBatteryPackage } | null> {
  const { organizationId, name } = params;
  const uploaded = await openappaDeclarations.resolveNewestStored({
    organizationId,
    name,
  });
  if (uploaded)
    return {
      entry: uploadedEntry({ name, contentHash: uploaded.contentHash }),
      battery: uploaded.battery,
    };
  const bundled = await openappaDeclarations.resolveInstalled({
    organizationId,
    name,
    packageHash: null,
  });
  return bundled ? { entry: bundledEntry(name), battery: bundled } : null;
}

/** The rows of each battery, batteries and rows in the order `list` answered. */
function groupByBattery(
  rows: readonly BatteryInstall[],
): Map<string, BatteryInstall[]> {
  const grouped = new Map<string, BatteryInstall[]>();
  for (const row of rows)
    grouped.set(row.batteryName, [
      ...(grouped.get(row.batteryName) ?? []),
      row,
    ]);
  return grouped;
}

/** Add a catalog's prefixes to a namespace's targets, keeping order and the text's own. */
function mergeTargets(params: {
  targets: Map<string, string[]>;
  resolution: PolicyResolution;
  namespace: string;
  carried: ReadonlySet<string>;
}): void {
  const { targets, resolution, namespace, carried } = params;
  const declared =
    targets.get(namespace) ??
    resolution.aliases.find((alias) => alias.namespace === namespace)
      ?.servers ??
    [];
  targets.set(namespace, [...new Set([...declared, ...carried])]);
}

/** One structured line per row the declarations do not carry, before it is lost. */
function drop(params: {
  organizationId: string;
  row: BatteryInstall;
  reason: DroppedReason;
  log: boolean;
}): void {
  if (!params.log) return;
  logger.warn(
    {
      organizationId: params.organizationId,
      battery: params.row.batteryName,
      catalogId: params.row.catalogId,
      reason: params.reason,
      // Store keys, never values: the value never appears in the policy either.
      bindings: params.row.credentialBindings,
    },
    "An OpenAPPA battery install is not carried into the policy declarations",
  );
}

/**
 * The revision the edits are measured against. Read from the model, not from
 * `guardrailsPolicyService`, so the step runs in a migration process that never
 * turned the feature flag on.
 */
async function latestRevision(
  organizationId: string,
): Promise<{ content: string; revision: number }> {
  const latest = await GuardrailsPolicyModel.findLatest(organizationId);
  return {
    content: latest?.content ?? INITIAL_POLICY,
    revision: latest?.revision ?? 0,
  };
}
