import { userHasPermission } from "@/auth";
import { OpenappaExternalConsultModel } from "@/models";
import type {
  AudienceLevel,
  AudienceSelectorRef,
  AudienceSource,
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
  toolHeaderLines,
} from "./policy-text";

/**
 * The trust levels and audiences the policy works with, read from the root
 * text and the batteries it includes: who belongs to each audience, which
 * rules name it, and the audience sources that answer it.
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
    const named = rulesByAudience([
      { entry: null, text: rootContent },
      ...batteries,
    ]);
    const mappings = audienceMappings(rootContent, policy);

    const audiences: AudienceLevel[] = [
      ...CHAIN_AUDIENCES,
      ...[...mappings.keys()].filter((name) => name.startsWith("@")),
    ].map((name) => {
      const mapping = mappings.get(name);
      const rules = {
        name,
        ruleCount: named.get(name)?.count ?? 0,
        firstRule: named.get(name)?.first ?? null,
      };
      if (mapping)
        return {
          ...rules,
          kind: "mapped",
          mappingLine: mapping.line,
          within: mapping.within,
          from: mapping.from.map((spelled) => selectorRef(spelled, declared)),
        };
      return {
        ...rules,
        kind: name !== "public" && rules.ruleCount > 0 ? "unmapped" : "builtin",
      };
    });

    const latest = canSeeAllConsults
      ? await OpenappaExternalConsultModel.findLatestByExternalName({
          organizationId: params.organizationId,
          role: "audience_source",
          externalNames: declared.map((source) => source.name),
        })
      : new Map();
    const sources: AudienceSource[] = declared.map(
      ({ templateLines: _, ...source }) => {
        const consult = latest.get(source.name);
        return {
          ...source,
          usedBy: audiences.flatMap((level) =>
            level.kind === "mapped" &&
            level.from.some((ref) => ref.source === source.name)
              ? [level.name]
              : [],
          ),
          lastConsult: consult
            ? { outcome: consult.outcome, at: consult.createdAt }
            : null,
        };
      },
    );

    return {
      trust: strings(policy?.trust_chain) ?? DEFAULT_TRUST_CHAIN,
      audiences,
      sources,
    };
  }
}

export const openappaTrustAudienceService = new OpenAppaTrustAudienceService();

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
type DeclaredSource = Omit<AudienceSource, "usedBy" | "lastConsult"> & {
  templateLines: Array<number | null>;
};
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
        const spelled = asRecord(selector);
        return typeof spelled?.template === "string"
          ? [
              {
                template: spelled.template,
                feeds: typeof spelled.feeds === "string" ? spelled.feeds : null,
              },
            ]
          : [];
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
        templateLines: templates.map(({ template }) =>
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
function selectorRef(
  spelled: string,
  sources: DeclaredSource[],
): AudienceSelectorRef {
  const split = spelled.indexOf(":");
  const source = split === -1 ? spelled : spelled.slice(0, split);
  const selector = split === -1 ? "" : spelled.slice(split + 1);
  const declared = sources.find((candidate) => candidate.name === source);
  const index =
    declared?.templates.findIndex(({ template }) =>
      templateMatches(template, selector),
    ) ?? -1;
  return {
    source,
    selector,
    entry: declared?.entry ?? null,
    line: declared?.templateLines[index] ?? declared?.line ?? null,
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

/**
 * How many rules name each audience in their `delta` or `requires`, and the
 * first, root first and then batteries in include order. A rule naming an
 * audience twice counts once.
 */
function rulesByAudience(
  files: PolicyFile[],
): Map<
  string,
  { count: number; first: { entry: string | null; line: number | null } }
> {
  const named = new Map<
    string,
    { count: number; first: { entry: string | null; line: number | null } }
  >();
  for (const file of files) {
    const entries = toolEntries(file.text);
    const headers = toolHeaderLines(file.text);
    const lines = headers.length === entries.length ? headers : [];
    entries.forEach((entry, index) => {
      const audiences = new Set([
        ...audienceNames(asRecord(entry.delta)?.audience),
        ...audienceNames(asRecord(entry.requires)?.audience),
      ]);
      for (const name of audiences) {
        const seen = named.get(name);
        if (seen) seen.count += 1;
        else
          named.set(name, {
            count: 1,
            first: { entry: file.entry, line: lines[index] ?? null },
          });
      }
    });
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
