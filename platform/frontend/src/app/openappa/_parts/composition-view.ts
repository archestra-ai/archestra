import type {
  PolicyBattery,
  PolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { formatDate } from "@/lib/utils/date-time";
import { BATTERY_STATUS, type EnforcedStatus } from "./battery-status";

/**
 * How the composition the runtime enforces holds a battery the current text
 * declares. A refused text keeps an earlier composition enforced, so its
 * statuses, not the refusal, say what runs; only a root text alone, served
 * because nothing ever composed, enforces nothing.
 */
export function enforcedStatus(
  declarations: PolicyDeclarations,
  battery: PolicyBattery,
): EnforcedStatus {
  const { served } = declarations.composition;
  if (served.kind === "current") return battery.status;
  if (served.kind === "root_only") return "refused";
  if (served.batteries === null) return battery.status;
  return battery.served?.status ?? "pending";
}

/**
 * What the current text would change for a battery the enforced composition
 * holds: the status it would hold the battery back with, or null.
 */
export function nowStatus(
  declarations: PolicyDeclarations,
  battery: PolicyBattery,
): PolicyBattery["status"] | null {
  if (declarations.composition.served.kind !== "previous") return null;
  const held = battery.served;
  if (!held || held.status === battery.status) return null;
  return BATTERY_STATUS[battery.status].severity === "ok"
    ? null
    : battery.status;
}

/** Whether a declared battery runs as it should: enforced, and nothing pending against it. */
export function batteryWorks(
  declarations: PolicyDeclarations,
  battery: PolicyBattery,
): boolean {
  return (
    BATTERY_STATUS[enforcedStatus(declarations, battery)].severity === "ok" &&
    nowStatus(declarations, battery) === null
  );
}

/**
 * The revision whose composition the runtime enforces, when it is not the
 * one the panel reads: shown beside each battery the composition holds.
 */
export function servedRevision(
  declarations: PolicyDeclarations,
): number | null {
  const { served, refusal } = declarations.composition;
  return served.kind === "previous" &&
    served.rootRevision !== null &&
    served.rootRevision !== refusal?.rootRevision
    ? served.rootRevision
    : null;
}

/**
 * Batteries the enforced composition holds that the current text no longer
 * declares: they stay enforced until a revision composes without them.
 */
export function servedOnly(
  declarations: PolicyDeclarations,
): { name: string; status: PolicyBattery["status"] }[] {
  const { served } = declarations.composition;
  if (served.kind !== "previous" || served.batteries === null) return [];
  const declared = new Set(declarations.batteries.map(({ name }) => name));
  return served.batteries
    .filter(({ name }) => !declared.has(name))
    .map(({ name, status }) => ({ name, status }));
}

/** The notice for a refused composition; null while the latest revision composed. */
export function compositionNotice(declarations: PolicyDeclarations): {
  variant: "warning" | "error";
  title: string;
  body: string;
} | null {
  const { served, refusal } = declarations.composition;
  if (served.kind === "current" || !refusal) return null;
  const until = declarations.managedInGithub
    ? "until a pull from the repository composes"
    : "until a revision composes";
  const refused =
    refusal.rootRevision === null
      ? "The latest revision"
      : `Revision ${refusal.rootRevision}`;
  if (served.kind === "root_only")
    return {
      variant: "error",
      title: "Nothing is enforced",
      body: `${refused} was refused and no composition has opened before, so governed calls are refused ${until}.`,
    };
  if (served.rootRevision === null)
    return {
      variant: "warning",
      title: `${refused} was refused`,
      body: `The composition that opened before it stays enforced ${until}. Statuses below are the current text's; the enforced composition may differ.`,
    };
  const composed = served.composedAt
    ? `, composed ${formatDate({ date: served.composedAt, dateFormat: "MMM d, yyyy HH:mm" })},`
    : "";
  if (served.rootRevision === refusal.rootRevision)
    return {
      variant: "warning",
      title: `Revision ${served.rootRevision} no longer composes`,
      body: `A package, server or credential changed since. Its earlier composition${composed} stays enforced ${until}.`,
    };
  return {
    variant: "warning",
    title: `${refused} was refused`,
    body: `Revision ${served.rootRevision}${composed} stays enforced ${until}. Statuses below are revision ${served.rootRevision}'s.`,
  };
}
