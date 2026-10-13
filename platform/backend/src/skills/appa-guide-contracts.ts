/**
 * OpenAPPA's policy reference is too long for one `load_skill` result, so
 * `pnpm codegen:appa-guide` splits it into these parts. Each part owns the
 * sections that start at its headings and run to the next listed heading;
 * every `## ` heading upstream must be listed.
 */
export const APPA_CONTRACTS_PARTS = [
  {
    slug: "tools",
    summary:
      "the policy file, tool contracts (canonical names, tags, pattern matching, undeclared tools), `include`, and deployment coverage. Read before declaring or matching tools.",
    headings: [
      "## Policy file",
      "## Tool contracts",
      "## Include policy files",
      "## Deployment coverage",
    ],
  },
  {
    slug: "audiences",
    summary:
      "restrictions and requirements, audiences (built-in, from tool arguments, source collections), the session principal, selector templates, reader IDs, and membership mapping. Read before a rule on who may read data.",
    headings: [
      "## Restrictions and requirements",
      "### Audiences",
      "### Session principal",
      "##### Map members with `lookup` and `readers`",
    ],
  },
  {
    slug: "labels",
    summary:
      "trust ranks, effects, and attention marks. Read before a rule on untrusted data, side effects, or attention.",
    headings: ["### Trust", "### Effects", "### Attention"],
  },
  {
    slug: "annotators",
    summary:
      "annotators: inputs, context providers, permits, and hints. Read before adding or changing an annotator.",
    headings: ["## Annotators"],
  },
  {
    slug: "sanitizers-authorities",
    summary:
      "sanitizers (permitted transitions, tool outputs and inputs) and authorities (permissions, tags, hints). Read before adding a sanitizer or an approval authority.",
    headings: ["## Sanitizers", "## Authorities"],
  },
  {
    slug: "returns",
    summary:
      "remedy plans, subagent returns, fan-out spawns, structured child returns, and a complete example policy. Read before protecting what a child returns to its parent.",
    headings: ["## Remedy plans and child returns"],
  },
  {
    slug: "externals",
    summary:
      "`[externals]`: HTTP services, local programs, model implementations, and Jev. Read before binding a helper service.",
    headings: ["## Externals", "### Model implementations"],
  },
  {
    slug: "protocols",
    summary:
      "wire protocols for helper implementers: membership requests, the annotator, sanitizer, and authority protocols, and the consult request. Only for writing or debugging a helper service, not for writing policy.",
    headings: [
      "##### Membership request protocol",
      "### Annotator protocol",
      "### Sanitizer protocol",
      "### Authority protocol",
      "### The consult request",
    ],
  },
] as const satisfies readonly {
  slug: string;
  summary: string;
  headings: readonly string[];
}[];

export type AppaContractsPartSlug =
  (typeof APPA_CONTRACTS_PARTS)[number]["slug"];

export function appaContractsPartPath(
  slug: AppaContractsPartSlug,
): `references/contracts/${AppaContractsPartSlug}.md` {
  return `references/contracts/${slug}.md`;
}

export function appaContractsPartFile(
  slug: AppaContractsPartSlug,
): `appa-guide.contracts.${AppaContractsPartSlug}.generated.md` {
  return `appa-guide.contracts.${slug}.generated.md`;
}

export const APPA_CONTRACTS_INDEX = `# OpenAPPA policy reference

OpenAPPA's policy reference defines what every policy field means, split into parts. Load only the part you need; a link into another part names that part's path.

${APPA_CONTRACTS_PARTS.map(({ slug, summary }) => `- \`${appaContractsPartPath(slug)}\`: ${summary}`).join("\n")}
`;
