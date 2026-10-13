import { userHasPermission } from "@/auth";
import { OpenappaExternalConsultModel } from "@/models";
import type { ExternalConsult } from "@/types/openappa-external-consults";
import type {
  AudienceLevel,
  AudienceSelectorRef,
  TrustAudienceView,
} from "@/types/openappa-trust-audience";
import { archestraAudience } from "./archestra-audience";
import { openappaBatteriesService } from "./batteries";
import {
  asRecord,
  assignsKey,
  lineInTable,
  parsePolicyToml,
  tableHeaderLine,
  toolEntries,
} from "./policy-text";

/**
 * The trust levels and audiences the policy works with, read from the root
 * text and the batteries it includes: who belongs to each audience, and the
 * audience sources that answer it.
 */
class OpenAppaTrustAudienceService {
  async view(params: {
    organizationId: string;
    userId: string;
  }): Promise<TrustAudienceView> {
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
    const batteries = resolution.entries.flatMap((included) =>
      included.battery
        ? [
            {
              name: included.name,
              entry: included.entry,
              packageHash: included.packageHash,
              text: included.battery.policy,
            },
          ]
        : [],
    );
    const policy = asRecord(parsePolicyToml(rootContent)?.policy);
    const declared = declaredSources(batteries);
    const named = audiencesNamedByRules([
      { entry: null, text: rootContent },
      ...batteries,
    ]);
    const mappings = audienceMappings(rootContent, policy);
    const latest = canSeeAllConsults
      ? await OpenappaExternalConsultModel.findLatestByExternalName({
          organizationId: params.organizationId,
          role: "audience_source",
          externalNames: declared.map((source) => source.name),
        })
      : new Map<string, LatestConsult>();

    const audiences: AudienceLevel[] = [
      ...CHAIN_AUDIENCES,
      ...[...mappings.keys()].filter((name) => name.startsWith("@")),
    ].map((name) => {
      const mapping = mappings.get(name);
      if (mapping)
        return {
          name,
          kind: "mapped",
          mappingLine: mapping.line,
          within: mapping.within,
          from: mapping.from.map((spelled) =>
            selectorRef({ spelled, sources: declared, latest }),
          ),
        };
      return {
        name,
        kind: name !== "public" && named.has(name) ? "unmapped" : "builtin",
      };
    });

    return {
      trust: strings(policy?.trust_chain) ?? DEFAULT_TRUST_CHAIN,
      audiences,
    };
  }
}

export const openappaTrustAudienceService = new OpenAppaTrustAudienceService();

/**
 * The levels a policy can label data with: trust ranks least trusted first,
 * and audiences widest first, `public` then `internal`, `self` and each
 * group. A group is narrower than the level it is declared `within`.
 */
export function policyLevels(
  files: Array<{ entry: string | null; text: string }>,
): {
  trust: string[];
  audiences: Array<{ name: string; width: number }>;
} {
  const root = files.find((file) => file.entry === null)?.text ?? "";
  const policy = asRecord(parsePolicyToml(root)?.policy);
  const mappings = audienceMappings(root, policy);
  const width = (name: string): number => {
    const chain = CHAIN_AUDIENCES.indexOf(name);
    if (chain >= 0) return chain;
    const within = mappings.get(name)?.within ?? "internal";
    return (
      (CHAIN_AUDIENCES.indexOf(within) >= 0
        ? CHAIN_AUDIENCES.indexOf(within)
        : 1) + 0.5
    );
  };
  // Mapped groups only: a rule may also name templated selectors such as
  // `@archestra:team/$team_ids`, which select readers rather than name a level.
  const names = [
    ...CHAIN_AUDIENCES,
    ...[...mappings.keys()].filter((name) => name.startsWith("@")),
  ];
  return {
    trust: strings(policy?.trust_chain) ?? DEFAULT_TRUST_CHAIN,
    audiences: names.map((name) => ({ name, width: width(name) })),
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * The runtime's trust chain when `[policy] trust_chain` is absent:
 * `DEFAULT_TRUST_CHAIN` in OpenAPPA's `appa-policy/src/config.rs`.
 */
const DEFAULT_TRUST_CHAIN = ["suspicious", "trusted"];

/**
 * The runtime's fixed audience chain, widest first: `self` ⊆ `internal` ⊆
 * `public` (`ChainAudience` in OpenAPPA's `appa-engine/src/label.rs`).
 */
const CHAIN_AUDIENCES = ["public", "internal", "self"];

type PolicyFile = { entry: string | null; text: string };
type IncludedBattery = PolicyFile & {
  entry: string;
  name: string;
  packageHash: string | null;
};
type DeclaredSource = {
  name: string;
  battery: string;
  entry: string;
  line: number | null;
  runBy: "archestra" | "helper";
  templates: string[];
  templateLines: Array<number | null>;
};
type LatestConsult = Pick<ExternalConsult, "outcome" | "createdAt">;
type Mapping = { from: string[]; line: number | null; within: string | null };

/** Every `[externals.audience.<name>]` the included batteries declare, in include order. */
function declaredSources(batteries: IncludedBattery[]): DeclaredSource[] {
  return batteries.flatMap((battery) => {
    const externals = asRecord(
      asRecord(parsePolicyToml(battery.text)?.externals)?.audience,
    );
    return Object.entries(externals ?? {}).map(([name, value]) => {
      const table = ["externals", "audience", name];
      const templates = (
        Array.isArray(asRecord(value)?.selectors)
          ? (asRecord(value)?.selectors as unknown[])
          : []
      ).flatMap((selector) => {
        const template = asRecord(selector)?.template;
        return typeof template === "string" ? [template] : [];
      });
      return {
        name,
        battery: battery.name,
        entry: battery.entry,
        line: tableHeaderLine(battery.text, table),
        runBy: archestraAudience.serves({
          batteryName: battery.name,
          packageHash: battery.packageHash,
          externalName: name,
        })
          ? ("archestra" as const)
          : ("helper" as const),
        templates,
        templateLines: templates.map((template) =>
          lineInTable({
            text: battery.text,
            table,
            matches: (line) =>
              new RegExp(`template\\s*=\\s*"${escapeRegExp(template)}"`).test(
                line,
              ),
          }),
        ),
      };
    });
  });
}

/**
 * `[policy.audience]`: the selectors `self` and `internal` read, and each
 * `[policy.audience.group.<name>]`, keyed as rules spell it (`@<name>`).
 */
function audienceMappings(
  rootText: string,
  policy: Record<string, unknown> | null,
): Map<string, Mapping> {
  const audience = asRecord(policy?.audience);
  const mappings = new Map<string, Mapping>();
  for (const name of ["internal", "self"]) {
    const from = strings(audience?.[name]);
    if (from)
      mappings.set(name, {
        from,
        within: null,
        line: lineInTable({
          text: rootText,
          table: ["policy", "audience"],
          matches: (line) => assignsKey(line, name),
        }),
      });
  }
  for (const [name, value] of Object.entries(asRecord(audience?.group) ?? {})) {
    const group = asRecord(value);
    mappings.set(`@${name}`, {
      from: strings(group?.from) ?? [],
      within: typeof group?.within === "string" ? group.within : null,
      line:
        tableHeaderLine(rootText, ["policy", "audience", "group", name]) ??
        lineInTable({
          text: rootText,
          table: ["policy", "audience", "group"],
          matches: (line) => assignsKey(line, name),
        }),
    });
  }
  return mappings;
}

/** `<source>:<selector>`, pointing at the template of the source that serves it. */
function selectorRef(params: {
  spelled: string;
  sources: DeclaredSource[];
  latest: Map<string, LatestConsult>;
}): AudienceSelectorRef {
  const split = params.spelled.indexOf(":");
  const source = split === -1 ? params.spelled : params.spelled.slice(0, split);
  const selector = split === -1 ? "" : params.spelled.slice(split + 1);
  const declared = params.sources.find(
    (candidate) => candidate.name === source,
  );
  if (!declared)
    return { source, selector, entry: null, line: null, declaredBy: null };
  const index = declared.templates.findIndex((template) =>
    templateMatches(template, selector),
  );
  const consult = params.latest.get(source);
  return {
    source,
    selector,
    entry: declared.entry,
    line: declared.templateLines[index] ?? declared.line,
    declaredBy: {
      battery: declared.battery,
      runBy: declared.runBy,
      lastConsult: consult
        ? { outcome: consult.outcome, at: consult.createdAt }
        : null,
    },
  };
}

/** Segment-wise, as the runtime matches: `<placeholder>` takes one non-empty segment. */
function templateMatches(template: string, selector: string): boolean {
  const pattern = template.split("/");
  const given = selector.split("/");
  return (
    pattern.length === given.length &&
    pattern.every((segment, i) =>
      segment.startsWith("<") && segment.endsWith(">")
        ? given[i] !== ""
        : segment === given[i],
    )
  );
}

/** Every audience some rule names in its `delta` or `requires`. */
function audiencesNamedByRules(files: PolicyFile[]): Set<string> {
  const named = new Set<string>();
  for (const file of files)
    for (const entry of toolEntries(file.text)) {
      for (const name of audienceNames(asRecord(entry.delta)?.audience))
        named.add(name);
      for (const name of audienceNames(asRecord(entry.requires)?.audience))
        named.add(name);
    }
  return named;
}

/** A `delta` audience list, or a `requires` audience's `contains` and `within`. */
function audienceNames(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return strings(value) ?? [];
  return [
    ...(strings(record.contains) ?? []),
    ...(strings(record.within) ?? []),
  ];
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
