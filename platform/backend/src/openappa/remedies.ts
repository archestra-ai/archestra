import { userHasPermission } from "@/auth";
import { OpenappaExternalConsultModel } from "@/models";
import type { ExternalConsult } from "@/types/openappa-external-consults";
import type {
  Authority,
  AuthorityPermits,
  BlockCoverage,
  BlockKind,
  RemediesView,
  RemedyImplementation,
  Sanitizer,
  SanitizerPermits,
} from "@/types/openappa-remedies";
import { openappaBatteriesService } from "./batteries";
import {
  arrayHeaderLines,
  asRecord,
  parsePolicyToml,
  toolEntries,
} from "./policy-text";

/**
 * The remedies the policy declares, read from the root text and the batteries
 * it includes: every authority and sanitizer, who runs it, what it may lift,
 * and which kinds of block the rules can cause that nothing wired lifts.
 */
class OpenAppaRemediesService {
  async view(params: {
    organizationId: string;
    userId: string;
  }): Promise<RemediesView> {
    const [{ rootContent, resolution }, canSeeAllConsults] = await Promise.all([
      openappaBatteriesService.coverageSnapshot(params.organizationId),
      // Consults are recorded per session; an org-wide status needs the
      // permission that shows every session's consults.
      userHasPermission(
        params.userId,
        params.organizationId,
        "openappaDiagnostics",
        "admin",
      ),
    ]);
    const files: PolicyFile[] = [
      { entry: null, battery: null, text: rootContent },
      ...resolution.entries.flatMap((included) =>
        included.battery
          ? [
              {
                entry: included.name === included.entry ? null : included.entry,
                battery: included.name,
                text: included.battery.policy,
              },
            ]
          : [],
      ),
    ];
    const externals = declaredExternals(files);
    const authorities = files.flatMap((file) =>
      declaredAuthorities(file, externals.authorities),
    );
    const sanitizers = files.flatMap((file) =>
      declaredSanitizers(file, externals.sanitizers),
    );
    const [authorityConsults, sanitizerConsults] = canSeeAllConsults
      ? await Promise.all([
          OpenappaExternalConsultModel.findLatestByExternalName({
            organizationId: params.organizationId,
            role: "authority",
            externalNames: authorities.map((each) => each.name),
          }),
          OpenappaExternalConsultModel.findLatestByExternalName({
            organizationId: params.organizationId,
            role: "sanitizer",
            externalNames: sanitizers.map((each) => each.name),
          }),
        ])
      : [new Map<string, LatestConsult>(), new Map<string, LatestConsult>()];

    return {
      authorities: authorities.map((authority) => ({
        ...authority,
        lastConsult: consultOf(authorityConsults, authority.name),
      })),
      sanitizers: sanitizers.map((sanitizer) => ({
        ...sanitizer,
        lastConsult: consultOf(sanitizerConsults, sanitizer.name),
      })),
      blocks: blockCoverage(files, authorities, sanitizers),
    };
  }
}

export const openappaRemediesService = new OpenAppaRemediesService();

// =============================================================================
// Internal helpers
// =============================================================================

type PolicyFile = {
  entry: string | null;
  battery: string | null;
  text: string;
};
type LatestConsult = Pick<ExternalConsult, "outcome" | "createdAt">;
type Externals = {
  authorities: Map<string, RemedyImplementation>;
  sanitizers: Map<string, RemedyImplementation>;
};

/** The runtime's named authority implementations under `builtin = "…"`. */
const AUTHORITY_BUILTINS: Record<string, RemedyImplementation["kind"]> = {
  hitl: "hitl",
  approve: "approve",
  llm: "llm",
  "claude-code": "claude_code",
};
/** The runtime's named sanitizer implementations under `builtin = "…"`. */
const SANITIZER_BUILTINS: Record<string, RemedyImplementation["kind"]> = {
  llm: "llm",
  "claude-code": "claude_code",
  "redact-email": "builtin",
  "redact-secrets": "builtin",
};

/** The reserved mark that denies a call; no authority may permit it. */
const BLOCKED_MARK = "blocked";

const BLOCK_KINDS: BlockKind[] = ["trust", "audience", "effects", "approvals"];

/**
 * Every `[externals.authorities.<name>]` and `[externals.sanitizers.<name>]`
 * across the files, keyed by name. A battery may wire what the root declares
 * and the other way round, so the files are read as one.
 */
function declaredExternals(files: PolicyFile[]): Externals {
  const externals: Externals = {
    authorities: new Map(),
    sanitizers: new Map(),
  };
  for (const file of files) {
    const declared = asRecord(parsePolicyToml(file.text)?.externals);
    for (const [name, value] of Object.entries(
      asRecord(declared?.authorities) ?? {},
    )) {
      const implementation = implementationOf(value, AUTHORITY_BUILTINS);
      if (implementation) externals.authorities.set(name, implementation);
    }
    for (const [name, value] of Object.entries(
      asRecord(declared?.sanitizers) ?? {},
    )) {
      const implementation = implementationOf(value, SANITIZER_BUILTINS);
      if (implementation) externals.sanitizers.set(name, implementation);
    }
  }
  return externals;
}

/** `builtin`, `url` or `command`, as the reference lists them; null when none is readable. */
function implementationOf(
  value: unknown,
  builtins: Record<string, RemedyImplementation["kind"]>,
): RemedyImplementation | null {
  const entry = asRecord(value);
  if (!entry) return null;
  if (typeof entry.builtin === "string")
    return {
      kind: builtins[entry.builtin] ?? "module",
      detail: entry.builtin,
    };
  if (typeof entry.url === "string")
    return { kind: "url", detail: hostOf(entry.url) };
  if (Array.isArray(entry.command))
    return {
      kind: "command",
      detail: typeof entry.command[0] === "string" ? entry.command[0] : null,
    };
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function declaredAuthorities(
  file: PolicyFile,
  wired: Map<string, RemedyImplementation>,
): Omit<Authority, "lastConsult">[] {
  const lines = arrayHeaderLines(file.text, ["policy", "authority"]);
  return declarations(file.text, "authority").map((entry, index) => ({
    kind: "authority",
    name: entry.name,
    source: {
      entry: file.entry,
      battery: file.battery,
      line: lines[index] ?? null,
    },
    implementation: wired.get(entry.name) ?? null,
    tags: strings(entry.tags) ?? [],
    permits: authorityPermits(entry.permits),
  }));
}

function declaredSanitizers(
  file: PolicyFile,
  wired: Map<string, RemedyImplementation>,
): Omit<Sanitizer, "lastConsult">[] {
  const lines = arrayHeaderLines(file.text, ["policy", "sanitizer"]);
  return declarations(file.text, "sanitizer").map((entry, index) => ({
    kind: "sanitizer",
    name: entry.name,
    source: {
      entry: file.entry,
      battery: file.battery,
      line: lines[index] ?? null,
    },
    implementation: wired.get(entry.name) ?? null,
    tags: strings(entry.tags) ?? [],
    on: (strings(entry.on) ?? []).filter(
      (each): each is Sanitizer["on"][number] =>
        each === "tool_output" || each === "tool_input",
    ),
    permits: sanitizerPermits(entry.permits),
  }));
}

/** Every `[[policy.<table>]]` entry with a string name, in text order. */
function declarations(
  text: string,
  table: "authority" | "sanitizer",
): Array<Record<string, unknown> & { name: string }> {
  const policy = asRecord(parsePolicyToml(text)?.policy);
  const list = Array.isArray(policy?.[table]) ? policy[table] : [];
  return list.flatMap((item) => {
    const entry = asRecord(item);
    return entry && typeof entry.name === "string"
      ? [{ ...entry, name: entry.name }]
      : [];
  });
}

function authorityPermits(value: unknown): AuthorityPermits {
  const permits = asRecord(value);
  return {
    attention: strings(permits?.attention) ?? [],
    audienceMissing: strings(permits?.audience_missing) ?? [],
    trustBelow:
      typeof permits?.trust_below === "string" ? permits.trust_below : null,
    effectsContaining: strings(permits?.effects_containing) ?? [],
  };
}

function sanitizerPermits(value: unknown): SanitizerPermits | null {
  const permits = asRecord(value);
  const audience = asRecord(permits?.audience);
  if (audience)
    return {
      kind: "audience",
      from: strings(audience.from) ?? [],
      to: strings(audience.to) ?? [],
    };
  const trust = asRecord(permits?.trust);
  if (trust && typeof trust.from === "string" && typeof trust.to === "string")
    return { kind: "trust", from: trust.from, to: trust.to };
  return null;
}

/**
 * For each kind of block, how many tool rules across the files can cause it
 * and how many wired remedies may lift it. Approval marks are matched by
 * name, since an authority gives a mark regardless of tags.
 */
function blockCoverage(
  files: PolicyFile[],
  authorities: Omit<Authority, "lastConsult">[],
  sanitizers: Omit<Sanitizer, "lastConsult">[],
): BlockCoverage[] {
  const rules = { trust: 0, audience: 0, effects: 0, approvals: 0 };
  const marks = new Set<string>();
  for (const file of files)
    for (const entry of toolEntries(file.text)) {
      const requires = asRecord(entry.requires);
      if (typeof requires?.trust === "string") rules.trust += 1;
      if (requires?.audience !== undefined) rules.audience += 1;
      if ((entry.excludes?.length ?? 0) > 0) rules.effects += 1;
      const required = (strings(requires?.attention) ?? []).filter(
        (mark) => mark !== BLOCKED_MARK,
      );
      if (required.length > 0) rules.approvals += 1;
      for (const mark of required) marks.add(mark);
    }
  const wiredAuthorities = authorities.filter((each) => each.implementation);
  const wiredSanitizers = sanitizers.filter((each) => each.implementation);
  const permitted = new Set(
    wiredAuthorities.flatMap((each) => each.permits.attention),
  );
  const unservedMarks = permitted.has("*")
    ? []
    : [...marks].filter((mark) => !permitted.has(mark)).sort();
  const approvers: Record<BlockKind, number> = {
    trust: wiredAuthorities.filter((each) => each.permits.trustBelow !== null)
      .length,
    audience: wiredAuthorities.filter(
      (each) => each.permits.audienceMissing.length > 0,
    ).length,
    effects: wiredAuthorities.filter(
      (each) => each.permits.effectsContaining.length > 0,
    ).length,
    approvals: wiredAuthorities.filter(
      (each) => each.permits.attention.length > 0,
    ).length,
  };
  const cleaners: Record<BlockKind, number> = {
    trust: wiredSanitizers.filter((each) => each.permits?.kind === "trust")
      .length,
    audience: wiredSanitizers.filter(
      (each) => each.permits?.kind === "audience",
    ).length,
    effects: 0,
    approvals: 0,
  };
  return BLOCK_KINDS.map((kind) => ({
    kind,
    rules: rules[kind],
    approvers: approvers[kind],
    cleaners: cleaners[kind],
    unservedMarks: kind === "approvals" ? unservedMarks : [],
    covered:
      kind === "approvals"
        ? unservedMarks.length === 0
        : rules[kind] === 0 || approvers[kind] + cleaners[kind] > 0,
  }));
}

function consultOf(
  latest: Map<string, LatestConsult>,
  name: string,
): { outcome: LatestConsult["outcome"]; at: Date } | null {
  const consult = latest.get(name);
  return consult ? { outcome: consult.outcome, at: consult.createdAt } : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;
}
