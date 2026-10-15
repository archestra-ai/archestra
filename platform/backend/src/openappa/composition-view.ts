import type {
  BatteryInstall,
  BatteryInstallStatus,
  BatteryScope,
  CompositionView,
  EffectivePolicy,
  PolicyBatteryView,
  ServedComposition,
} from "@/types/openappa-batteries";
import { asRecord, parsePolicyToml } from "./policy-text";

/**
 * What the runtime enforces, told apart from what was refused.
 *
 * A refused composition keeps serving the last one that opened, so the stored
 * row's `last_error` says the latest attempt failed, not that nothing is
 * enforced. The row's `served` record says where its `content` came from: a
 * composition of a known revision with its batteries' statuses, or the root
 * text alone when no composition ever opened. A record is trusted only while
 * it describes the row's bytes (`contentHash`), so a value a build that does
 * not write it left behind is never read.
 */

/**
 * A battery composes its own policy only while it is active: a battery held
 * back by a missing credential, an unresolved server or a naming conflict
 * composes as the empty battery, exactly as an unresolved entry does, so the
 * runtime never consults a helper the host cannot serve. An organization-wide
 * battery waiting on a credential still composes its base.
 */
export function composes(battery: {
  status: BatteryInstallStatus;
  scope: BatteryScope;
}): boolean {
  switch (battery.status) {
    case "active":
    case "unrouted":
      return true;
    case "missing_credentials":
      return battery.scope === "organization";
    case "unavailable":
    case "naming_conflict":
    case "server_missing":
    case "refused":
      return false;
  }
}

/** The install whose id a battery's helper URLs carry: its earliest row. */
export function helperOwner(
  installs: readonly BatteryInstall[],
  name: string,
): BatteryInstall | null {
  return (
    installs
      .filter((install) => install.batteryName === name)
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )[0] ?? null
  );
}

/** The record an accepted composition stores beside its bytes. */
export function servedSnapshot(params: {
  batteries: readonly PolicyBatteryView[];
  installs: readonly BatteryInstall[];
  contentHash: string;
  rootRevision: number;
  composedAt: Date;
}): ServedComposition {
  return {
    v: 1,
    kind: "composition",
    contentHash: params.contentHash,
    rootRevision: params.rootRevision,
    composedAt: params.composedAt.toISOString(),
    batteries: params.batteries.map((battery) => {
      const owner = helperOwner(params.installs, battery.name);
      return {
        entry: battery.entry,
        name: battery.name,
        status: battery.status,
        composed: battery.composed,
        packageHash: battery.packageHash,
        target: owner?.target ?? null,
        installId: owner?.id ?? null,
        credentialBindings: owner?.credentialBindings ?? {},
      };
    }),
  };
}

/**
 * What a refusal keeps serving, given the row it replaces: that row's record
 * when it describes the row, or one derived once for a row an earlier build
 * stored. Null when what it serves is the root text alone, which the caller
 * then replaces with the current root text.
 */
export function carriedServed(params: {
  expected: EffectivePolicy;
  installs: readonly BatteryInstall[];
}): ServedComposition | null {
  const { expected, installs } = params;
  if (anchored(expected))
    return expected.served.kind === "root_only" ? null : expected.served;
  if (expected.lastError === null)
    return {
      v: 1,
      kind: "composition",
      contentHash: expected.contentHash,
      rootRevision: expected.rootRevision,
      composedAt: expected.compiledAt.toISOString(),
      // Rows another write changed since that composition no longer say what
      // it composed with.
      batteries: installs.every(
        (install) =>
          install.lastError === null &&
          install.updatedAt.getTime() <= expected.compiledAt.getTime(),
      )
        ? servedFromRows(installs)
        : null,
    };
  // A refusal an earlier build stored. Only the root text spells `include`;
  // a composition has resolved it.
  if (asRecord(parsePolicyToml(expected.content))?.include !== undefined)
    return null;
  return {
    v: 1,
    kind: "composition",
    contentHash: expected.contentHash,
    rootRevision: null,
    composedAt: null,
    batteries: null,
  };
}

/** The stored row as two facts: what is served, and what the latest attempt refused. */
export function compositionView(row: EffectivePolicy): CompositionView {
  if (row.lastError === null)
    return {
      served: {
        kind: "current",
        rootRevision: row.rootRevision,
        composedAt: row.compiledAt,
      },
      refusal: null,
    };
  const refusal = {
    message: row.lastError,
    at: row.lastErrorAt ?? row.compiledAt,
    rootRevision: row.rootRevision < 0 ? null : row.rootRevision,
  };
  if (!anchored(row))
    return {
      served: {
        kind: "previous",
        rootRevision: null,
        composedAt: null,
        batteries: null,
      },
      refusal,
    };
  const { served } = row;
  if (served.kind === "root_only")
    return { served: { kind: "root_only" }, refusal };
  return {
    served: {
      kind: "previous",
      rootRevision: served.rootRevision,
      composedAt: served.composedAt ? new Date(served.composedAt) : null,
      batteries:
        served.batteries?.map(({ name, status, composed }) => ({
          name,
          status,
          composed,
        })) ?? null,
    },
    refusal,
  };
}

/**
 * How the enforced composition holds a battery the current text declares:
 * its own status under a current composition, the status it was composed
 * with under an earlier one (`pending` when that one did not hold it), and
 * `refused` when only the root text is served.
 */
export function enforcedBattery(
  view: CompositionView,
  battery: { name: string; status: BatteryInstallStatus; composed: boolean },
): { status: BatteryInstallStatus | "pending"; composed: boolean } {
  const { served } = view;
  if (served.kind === "current")
    return { status: battery.status, composed: battery.composed };
  if (served.kind === "root_only")
    return { status: "refused", composed: false };
  if (served.batteries === null)
    return { status: battery.status, composed: battery.composed };
  const held = served.batteries.find((entry) => entry.name === battery.name);
  return held
    ? { status: held.status, composed: held.composed }
    : { status: "pending", composed: false };
}

/**
 * The install a helper URL of the enforced composition names, as that
 * composition deployed it. Null unless a refusal holds and the record knows
 * the install: otherwise the install row itself is what the composition uses.
 */
export function servedHelperSource(
  row: Pick<EffectivePolicy, "organizationId" | "contentHash" | "lastError"> & {
    served: ServedComposition | null;
  },
  installId: string,
): {
  id: string;
  organizationId: string;
  batteryName: string;
  packageHash: string | null;
  target: "multi-user" | null;
  credentialBindings: Record<string, string>;
} | null {
  if (row.lastError === null || !anchored(row)) return null;
  if (row.served.kind !== "composition") return null;
  const battery = row.served.batteries?.find(
    (entry) => entry.installId === installId,
  );
  return battery
    ? {
        id: installId,
        organizationId: row.organizationId,
        batteryName: battery.name,
        packageHash: battery.packageHash,
        target: battery.target,
        credentialBindings: battery.credentialBindings,
      }
    : null;
}

// =============================================================================
// Internal helpers
// =============================================================================

function anchored<
  T extends { contentHash: string; served: ServedComposition | null },
>(row: T): row is T & { served: ServedComposition } {
  return row.served !== null && row.served.contentHash === row.contentHash;
}

/** One served battery per name, from the rows a composition deployed with. */
function servedFromRows(
  installs: readonly BatteryInstall[],
): NonNullable<
  Extract<ServedComposition, { kind: "composition" }>["batteries"]
> {
  const names = [...new Set(installs.map((install) => install.batteryName))];
  return names.flatMap((name) => {
    const owner = helperOwner(installs, name);
    if (!owner) return [];
    const scope: BatteryScope =
      owner.catalogId === null ? "organization" : "catalogs";
    return [
      {
        entry: null,
        name,
        status: owner.status,
        composed: composes({ status: owner.status, scope }),
        packageHash: owner.packageHash,
        target: owner.target,
        installId: owner.id,
        credentialBindings: owner.credentialBindings,
      },
    ];
  });
}
