import { isDeepStrictEqual } from "node:util";
import { stringify as stringifyToml } from "smol-toml";
import { asRecord, parsePolicyToml } from "./policy-text";

/**
 * Annotators a session's opening policy declares stay answerable after the
 * organization's policy stops declaring them. A session decides under the
 * policy it opened with, but the runtime answers its consults with the
 * externals of the policy served now, looked up by name: a renamed or removed
 * annotator would refuse every annotated call of the sessions opened before
 * the change. So the host declares each such annotator again exactly as the
 * opening policy did, with the externals table and credential binding that
 * answered it. The runtime's stored opening policies are the ledger.
 *
 * Temporary: this goes away once the runtime answers a session's consults
 * from the policy it opened with.
 */

/** The parts of a stored opening policy this reads, parsed once per hash. */
export type OpeningPolicy = {
  hash: string;
  annotators: Record<string, unknown>[];
  externals: Record<string, unknown>;
  credentials: Record<string, unknown>;
};

/** An annotator kept for earlier sessions, with what answers it. */
export type KeptAnnotator = {
  name: string;
  /** Its `[[policy.annotator]]` table, verbatim. */
  declaration: Record<string, unknown>;
  /** Its original externals tables, by key path under `externals`. */
  externals: { path: string[]; table: Record<string, unknown> }[];
  /** The original `[credentials]` entries those tables need. */
  credentials: Record<string, string>;
  /** What answers it, for logs and warnings: `builtin "x"` or its URL. */
  binding: string;
};

/** Read what keeping needs from a stored opening policy; null when it is not TOML. */
export function readOpeningPolicy(
  hash: string,
  content: string,
): OpeningPolicy | null {
  const document = parsePolicyToml(content);
  if (!document) return null;
  return {
    hash,
    annotators: records(asRecord(document.policy)?.annotator),
    externals: asRecord(document.externals) ?? {},
    credentials: asRecord(document.credentials) ?? {},
  };
}

/**
 * Every annotator an opening policy declares that `composed` does not, with
 * the externals tables and credentials that answered it there. Two opening
 * policies binding a name differently cannot be safely served by one binding.
 * A name is dropped, with the reason, when a credential it needs
 * is not readable now or its helper URL names an install that is gone.
 */
export function retiredAnnotators(params: {
  openings: readonly OpeningPolicy[];
  composed: string;
  /** Credential keys the organization can read now. */
  readable: ReadonlySet<string>;
  /** The URL prefix of this host's battery helpers, followed by an install id. */
  helperBase: string;
  /** Install ids that exist now. */
  installs: ReadonlySet<string>;
}): {
  kept: KeptAnnotator[];
  dropped: { name: string; reason: string }[];
  conflicts: string[];
  refusal: string[];
} {
  const composed = readOpeningPolicy("", params.composed);
  if (!composed) return { kept: [], dropped: [], conflicts: [], refusal: [] };
  const declared = new Map(
    composed.annotators.map((table) => [table.name, table]),
  );
  const winners = new Map<string, KeptAnnotator>();
  const conflicts = new Set<string>();
  const refusal = new Set<string>();
  const ordered = [...params.openings].sort((a, b) =>
    a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0,
  );
  for (const opening of ordered)
    for (const declaration of opening.annotators) {
      const name = declaration.name;
      if (typeof name !== "string") continue;
      const candidate = keptFrom({ opening, declaration, name });
      const current = declared.get(name);
      if (current) {
        if (
          !sameBinding(
            candidate,
            keptFrom({ opening: composed, declaration: current, name }),
          )
        )
          refusal.add(
            `annotator "${name}" is used by earlier sessions with a different binding. Use a new annotator name to keep their original binding.`,
          );
        continue;
      }
      const earlier = winners.get(name);
      if (earlier && !sameBinding(earlier, candidate)) conflicts.add(name);
      winners.set(name, candidate);
    }
  const kept: KeptAnnotator[] = [];
  const dropped: { name: string; reason: string }[] = [];
  let bindings = composed;
  for (const candidate of winners.values()) {
    const reason = conflicts.has(candidate.name)
      ? "earlier sessions require different bindings for this name"
      : unkeepable({ ...params, candidate, composed: bindings });
    if (reason) dropped.push({ name: candidate.name, reason });
    else {
      kept.push(candidate);
      // Retained names can share a builtin profile too. Do not let the next
      // candidate replace a dependency already kept for another old name.
      bindings =
        readOpeningPolicy(
          "",
          withKeptAnnotators(params.composed, kept) ?? params.composed,
        ) ?? composed;
    }
  }
  return { kept, dropped, conflicts: [...conflicts], refusal: [...refusal] };
}

/**
 * The root text with the kept annotators declared in it, their externals
 * tables and credential entries added; null when the root is not TOML.
 */
export function withKeptAnnotators(
  root: string,
  kept: readonly KeptAnnotator[],
): string | null {
  const document = parsePolicyToml(root);
  if (!document) return null;
  const policy = child(document, "policy");
  policy.annotator = [
    ...records(policy.annotator),
    ...kept.map((annotator) => annotator.declaration),
  ];
  for (const annotator of kept) {
    for (const { path, table } of annotator.externals) {
      const parent = path
        .slice(0, -1)
        .reduce(child, child(document, "externals"));
      const key = path[path.length - 1];
      if (parent[key] === undefined) parent[key] = table;
    }
    if (Object.keys(annotator.credentials).length > 0)
      document.credentials = {
        ...annotator.credentials,
        ...asRecord(document.credentials),
      };
  }
  return `# kept by the host for sessions opened under an earlier policy: ${kept
    .map((annotator) => annotator.name)
    .join(", ")}\n${stringifyToml(document)}`;
}

// =============================================================================
// Internal helpers
// =============================================================================

/** A declaration with the externals and credentials it needs from its opening policy. */
function keptFrom(params: {
  opening: OpeningPolicy;
  declaration: Record<string, unknown>;
  name: string;
}): KeptAnnotator {
  const { opening, declaration, name } = params;
  const builtin =
    typeof declaration.builtin === "string" ? declaration.builtin : null;
  // A builtin reads its settings from `[externals.<builtin>]`; an annotator
  // without one is answered by its own table. The archestra and claude-code
  // builtins need no table.
  const path =
    builtin === null
      ? ["annotators", name]
      : CONFIGLESS_BUILTINS.has(builtin)
        ? null
        : [builtin];
  const table = path ? asRecord(at(opening.externals, path)) : null;
  const externals = path && table ? [{ path, table }] : [];
  const credentials: Record<string, string> = {};
  for (const variable of externals.flatMap(({ table }) => envVariables(table)))
    if (typeof opening.credentials[variable] === "string")
      credentials[variable] = opening.credentials[variable];
  const url = table && typeof table.url === "string" ? table.url : null;
  return {
    name,
    declaration,
    externals,
    credentials,
    binding:
      builtin !== null ? `builtin "${builtin}"` : (url ?? "its own table"),
  };
}

/** Why a candidate cannot be kept, or null when it can. */
function unkeepable(params: {
  candidate: KeptAnnotator;
  readable: ReadonlySet<string>;
  helperBase: string;
  installs: ReadonlySet<string>;
  composed: OpeningPolicy;
}): string | null {
  const { candidate, readable, helperBase, installs, composed } = params;
  for (const [variable, key] of Object.entries(candidate.credentials))
    if (
      composed.credentials[variable] !== undefined &&
      composed.credentials[variable] !== key
    )
      return `the current policy binds ${variable} to a different credential`;
    else if (!readable.has(key))
      return `its credential ${variable} is bound to "${key}", which the organization can no longer read`;
  for (const { path, table } of candidate.externals) {
    const current = at(composed.externals, path);
    if (current !== undefined && !isDeepStrictEqual(current, table))
      return `the current policy uses a different externals.${path.join(".")} binding`;
    const url = typeof table.url === "string" ? table.url : null;
    if (!url?.startsWith(helperBase)) continue;
    const install = url.slice(helperBase.length).split("/")[0];
    if (!installs.has(install))
      return "the battery install whose helper answered it no longer exists";
  }
  return null;
}

function sameBinding(a: KeptAnnotator, b: KeptAnnotator): boolean {
  return (
    a.declaration.builtin === b.declaration.builtin &&
    isDeepStrictEqual(a.externals, b.externals) &&
    isDeepStrictEqual(a.credentials, b.credentials)
  );
}

/** Every variable a table names through a `*_env` key, at any depth. */
function envVariables(table: Record<string, unknown>): string[] {
  return Object.entries(table).flatMap(([key, value]) => {
    if (key.endsWith("_env") && typeof value === "string") return [value];
    const nested = asRecord(value);
    return nested ? envVariables(nested) : [];
  });
}

/** The table under `key`, created when missing. */
function child(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = asRecord(parent[key]);
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function at(root: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = root;
  for (const key of path) value = asRecord(value)?.[key];
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

/** Builtins the runtime answers without an externals table. */
const CONFIGLESS_BUILTINS = new Set(["archestra", "claude-code"]);
