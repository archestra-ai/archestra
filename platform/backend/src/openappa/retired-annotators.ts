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
 * What is kept follows the ledger and the organization's readable credential
 * keys (batteries.ts `retirement`). A change the host makes itself recomposes
 * at once; a credential that becomes unreadable behind the host's back is
 * caught by the next dispatch; one that becomes readable again, or a session
 * that opened under the previous composition while a new one was stored,
 * waits for the next reading of those inputs, at most a minute per replica.
 *
 * Temporary: this goes away once the runtime answers a session's consults
 * from the policy it opened with.
 */

/** The parts of a stored opening policy this reads, parsed once per hash. */
export type OpeningPolicy = {
  hash: string;
  annotators: Record<string, unknown>[];
  routedAnnotators: ReadonlySet<string>;
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
    routedAnnotators: new Set(
      records(asRecord(document.policy)?.tool).flatMap((table) =>
        typeof table.annotator === "string" ? [table.annotator] : [],
      ),
    ),
    externals: asRecord(document.externals) ?? {},
    credentials: asRecord(document.credentials) ?? {},
  };
}

/**
 * A name the composition still declares that an earlier opening policy bound
 * differently. The runtime answers consults by name from the served policy,
 * so sessions opened under that earlier policy are answered by `current`.
 */
export type Rebinding = {
  name: string;
  /** What answers it now, as `KeptAnnotator.binding` spells it. */
  current: string;
  /** What answered it under earlier policies, distinct, in hash order. */
  earlier: string[];
};

/**
 * An annotator the opening policy routes calls to that the served policy does
 * not still answer the same way. Unused retained declarations do not count.
 * `helperBase` is this host's battery helper URL prefix: a helper served under
 * a new install id, port or token variable still answers the same way.
 */
export function unservedAnnotator(params: {
  opening: string;
  served: string;
  helperBase: string;
}): string | null {
  const opening = readOpeningPolicy("", params.opening);
  const served = readOpeningPolicy("", params.served);
  if (!opening || !served) return null;
  const current = new Map(
    served.annotators.flatMap((table) =>
      typeof table.name === "string" ? [[table.name, table] as const] : [],
    ),
  );
  for (const declaration of opening.annotators) {
    const name = declaration.name;
    if (typeof name !== "string" || !opening.routedAnnotators.has(name))
      continue;
    const required = keptFrom({ opening, declaration, name });
    const present = current.get(name);
    if (
      !present ||
      !sameBinding({
        a: required,
        b: keptFrom({ opening: served, declaration: present, name }),
        helperBase: params.helperBase,
      })
    )
      return name;
  }
  return null;
}

/**
 * Every annotator an opening policy declares that `composed` does not, with
 * the externals tables and credentials that answered it there. Two opening
 * policies binding a name differently cannot be safely served by one binding.
 * A name is dropped, with the reason, when a credential it needs
 * is not readable now or its helper URL names an install that is gone.
 *
 * A name `composed` still declares is never kept, since one name has one
 * binding: it is reported in `rebound` when an opening policy bound it
 * differently. This host's own helper URLs compare by external name, so a
 * battery helper served under a new install id, port or token variable is
 * the same binding and not a rebinding.
 */
export function retiredAnnotators(params: {
  openings: readonly OpeningPolicy[];
  composed: string;
  /** Credential keys the organization can read now. */
  readable: ReadonlySet<string>;
  /** The URL prefix of this host's battery helpers, followed by an install id. */
  helperBase: string;
  /** The variable this host's helper bindings name as their bearer now. */
  helperTokenEnv: string;
  /** Install ids that exist now. */
  installs: ReadonlySet<string>;
}): {
  kept: KeptAnnotator[];
  dropped: { name: string; reason: string }[];
  conflicts: string[];
  rebound: Rebinding[];
} {
  const composed = readOpeningPolicy("", params.composed);
  if (!composed) return { kept: [], dropped: [], conflicts: [], rebound: [] };
  const declared = new Map(
    composed.annotators.map((table) => [table.name, table]),
  );
  const winners = new Map<string, KeptAnnotator>();
  const conflicts = new Set<string>();
  const rebound = new Map<string, Rebinding>();
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
        const now = keptFrom({ opening: composed, declaration: current, name });
        if (
          !sameBinding({ a: candidate, b: now, helperBase: params.helperBase })
        ) {
          const entry = rebound.get(name) ?? {
            name,
            current: described(now),
            earlier: [],
          };
          if (!entry.earlier.includes(described(candidate)))
            entry.earlier.push(described(candidate));
          rebound.set(name, entry);
        }
        continue;
      }
      const earlier = winners.get(name);
      if (
        earlier &&
        sameBinding({ a: earlier, b: candidate, helperBase: params.helperBase })
      ) {
        // Snapshots of one helper differ only in what the host generated:
        // keep the one whose install still answers.
        if (
          !helperAnswers({ ...params, annotator: earlier }) &&
          helperAnswers({ ...params, annotator: candidate })
        )
          winners.set(name, candidate);
        continue;
      }
      if (earlier) conflicts.add(name);
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
      kept.push(atThisHost({ ...params, annotator: candidate }));
      // Retained names can share a builtin profile too. Do not let the next
      // candidate replace a dependency already kept for another old name.
      bindings =
        readOpeningPolicy(
          "",
          withKeptAnnotators(params.composed, kept) ?? params.composed,
        ) ?? composed;
    }
  }
  return {
    kept,
    dropped,
    conflicts: [...conflicts],
    rebound: [...rebound.values()],
  };
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
  return stringifyToml(document);
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

/** `binding` with the credentials it uses, so two bindings read apart in a message. */
function described(annotator: KeptAnnotator): string {
  const entries = Object.entries(annotator.credentials).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return entries.length === 0
    ? annotator.binding
    : `${annotator.binding} with ${entries
        .map(([variable, key]) => `${variable} = "${key}"`)
        .join(", ")}`;
}

/** Whether every host helper a candidate names has an install now; true without one. */
function helperAnswers(params: {
  annotator: KeptAnnotator;
  helperBase: string;
  installs: ReadonlySet<string>;
}): boolean {
  return params.annotator.externals.every(({ table }) => {
    const helper = hostHelper(table.url, params.helperBase);
    return helper === null || params.installs.has(helper.install);
  });
}

/**
 * A kept annotator with its host helper tables rewritten to this host: the
 * port and the bearer variable are the deployment's now, not the snapshot's.
 */
function atThisHost(params: {
  annotator: KeptAnnotator;
  helperBase: string;
  helperTokenEnv: string;
}): KeptAnnotator {
  const { annotator, helperBase, helperTokenEnv } = params;
  let binding = annotator.binding;
  const externals = annotator.externals.map(({ path, table }) => {
    const helper = hostShaped(table) ? hostHelper(table.url, helperBase) : null;
    if (!helper) return { path, table };
    const base = new URL(helperBase);
    const url = `${base.origin}/${[
      ...base.pathname.split("/").filter(Boolean),
      helper.install,
      helper.external,
    ].join("/")}`;
    if (binding === table.url) binding = url;
    return { path, table: { url, token_env: helperTokenEnv } };
  });
  return { ...annotator, externals, binding };
}

/** Whether a table has the shape the host writes for its helpers: a URL and its bearer variable. */
function hostShaped(table: Record<string, unknown>): boolean {
  return (
    typeof table.url === "string" &&
    Object.keys(table).every((key) => key === "url" || key === "token_env")
  );
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
    const install = helperInstall(table.url, helperBase);
    if (install && !installs.has(install))
      return "the battery install whose helper answered it no longer exists";
  }
  return null;
}

/**
 * Whether two annotators are answered the same way. Tables of this host's own
 * helpers compare by the external they name: the install id, port and token
 * variable in them are the host's to change and never redirect a session.
 */
function sameBinding(params: {
  a: KeptAnnotator;
  b: KeptAnnotator;
  helperBase: string;
}): boolean {
  const { a, b, helperBase } = params;
  const identity = (annotator: KeptAnnotator) =>
    annotator.externals.map(({ path, table }) => {
      const helper = hostShaped(table)
        ? hostHelper(table.url, helperBase)
        : null;
      return { path, table: helper ? { hostHelper: helper.external } : table };
    });
  return (
    a.declaration.builtin === b.declaration.builtin &&
    isDeepStrictEqual(identity(a), identity(b)) &&
    isDeepStrictEqual(a.credentials, b.credentials)
  );
}

/** The install id in a host helper URL, or null when the URL is not one. */
function helperInstall(value: unknown, helperBase: string): string | null {
  return hostHelper(value, helperBase)?.install ?? null;
}

/**
 * The install id and external name a URL of this host's battery helpers
 * names, or null when the URL is not one. The host serves its helpers on the
 * loopback address `helperBase` names; the port is the deployment's and may
 * differ between the snapshot and now.
 */
function hostHelper(
  value: unknown,
  helperBase: string,
): { install: string; external: string } | null {
  if (typeof value !== "string") return null;
  let target: URL;
  let base: URL;
  try {
    target = new URL(value);
    base = new URL(helperBase);
  } catch {
    return null;
  }
  if (target.protocol !== base.protocol || target.hostname !== base.hostname)
    return null;
  const prefix = base.pathname.split("/").filter(Boolean);
  const path = target.pathname.split("/").filter(Boolean);
  if (path.length < prefix.length + 2) return null;
  if (prefix.some((segment, index) => segment !== path[index])) return null;
  return {
    install: path[prefix.length],
    external: path.slice(prefix.length + 1).join("/"),
  };
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
