import type {
  AgentAdoption,
  AgentAdoptionMember,
} from "@/lib/connected-client.query";
import { agentLabel } from "./agent-icon";

export type Dimension = "user" | "agent" | "service" | "kind";
export type Metric = "calls" | "mcp" | "llm";
export type Scope = Partial<Record<Dimension, string>>;
export type Fact = {
  user: string;
  userName: string;
  email: string;
  agent: string;
  agentName: string;
  clientId: string | null;
  service: string;
  serviceName: string;
  kind: "mcp" | "llm";
  calls: number;
  lastSeenAt: string;
};
export type Group = {
  key: string;
  label: string;
  detail: string;
  dimension: Dimension;
  facts: Fact[];
  calls: number;
  mcp: number;
  llm: number;
  users: number;
  agents: number;
  lastSeenAt: string | null;
};

/** Complete call attributions for the selected range, independent of the paged event log. */
export function factsOf(adoption: AgentAdoption): Fact[] {
  return adoption.members.flatMap((member) =>
    [
      ...member.gatewayUses.map((use) => ({ use, kind: "mcp" as const })),
      ...member.llmUses.map((use) => ({ use, kind: "llm" as const })),
    ].map(({ use, kind }) => ({
      user: member.userId,
      userName: member.name || member.email,
      email: member.email,
      // Group one agent product across installations belonging to different users.
      agent: agentLabel(use.agent).toLowerCase(),
      agentName: agentLabel(use.agent),
      clientId: use.agent.clientId,
      // A gateway and a proxy may share an id or display name.
      service: `${kind}:${use.via.id ?? use.via.name}`,
      serviceName: use.via.name,
      kind,
      calls: use.calls,
      lastSeenAt: use.lastSeenAt,
    })),
  );
}

export function filterFacts({
  facts,
  scope,
  search = "",
  metric = "calls",
}: {
  facts: Fact[];
  scope: Scope;
  search?: string;
  metric?: Metric;
}): Fact[] {
  const query = search.trim().toLowerCase();
  return facts.filter(
    (fact) =>
      (metric === "calls" || fact.kind === metric) &&
      Object.entries(scope).every(
        ([key, value]) => fact[key as Dimension] === value,
      ) &&
      (!query ||
        [fact.userName, fact.email, fact.agentName, fact.serviceName, fact.kind]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
}

export function amount(facts: Fact[], metric: Metric = "calls"): number {
  return facts.reduce(
    (sum, fact) =>
      sum + (metric === "calls" || fact.kind === metric ? fact.calls : 0),
    0,
  );
}

export function groupsOf({
  facts,
  dimension,
  members,
  scope,
  search = "",
}: {
  facts: Fact[];
  dimension: Dimension;
  members: AgentAdoptionMember[];
  scope: Scope;
  search?: string;
}): Group[] {
  const buckets = new Map<string, Fact[]>();
  for (const fact of facts) {
    const key = fact[dimension];
    const bucket = buckets.get(key);
    if (bucket) bucket.push(fact);
    else buckets.set(key, [fact]);
  }
  const rows: Group[] = [...buckets].map(([key, entries]) => {
    const first = entries[0];
    const users = new Set(entries.map((fact) => fact.user)).size;
    return {
      key,
      dimension,
      label:
        dimension === "user"
          ? first.userName
          : dimension === "agent"
            ? first.agentName
            : dimension === "service"
              ? first.serviceName
              : key.toUpperCase(),
      detail:
        dimension === "user"
          ? first.email
          : dimension === "service"
            ? first.kind === "mcp"
              ? "MCP gateway"
              : "LLM proxy"
            : dimension === "agent"
              ? `${users} ${users === 1 ? "user" : "users"}`
              : "Call type",
      facts: entries,
      calls: amount(entries),
      mcp: amount(entries, "mcp"),
      llm: amount(entries, "llm"),
      users,
      agents: new Set(entries.map((fact) => fact.agent)).size,
      lastSeenAt: entries.reduce(
        (latest, fact) =>
          Date.parse(fact.lastSeenAt) > Date.parse(latest)
            ? fact.lastSeenAt
            : latest,
        first.lastSeenAt,
      ),
    };
  });
  // Keep users with no calls visible at the root; a scoped view contains only matching paths.
  if (dimension === "user" && !scope.user && !scope.agent && !scope.service) {
    const present = new Set(rows.map((row) => row.key));
    const query = search.trim().toLowerCase();
    for (const member of members) {
      if (
        present.has(member.userId) ||
        (query &&
          !`${member.name} ${member.email}`.toLowerCase().includes(query))
      )
        continue;
      rows.push({
        key: member.userId,
        label: member.name || member.email,
        detail: member.email,
        dimension,
        facts: [],
        calls: 0,
        mcp: 0,
        llm: 0,
        users: 0,
        agents: 0,
        lastSeenAt: null,
      });
    }
  }
  return rows.sort(
    (a, b) => b.calls - a.calls || a.label.localeCompare(b.label),
  );
}
