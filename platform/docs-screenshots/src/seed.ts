import fs from "node:fs";
import { type ArchestraApi, items } from "./api";
import {
  AGENTS,
  ENVIRONMENTS,
  KNOWLEDGE_BASES,
  LIMITS,
  MCP_GATEWAYS,
  PLUGINS,
  PROJECTS,
  REMOTE_MCP_SERVERS,
  SKILLS,
  TEAMS,
} from "./dataset";
import { SEED_STATE_FILE, STATE_DIR } from "./env";

type Named = { id: string; name: string };
type Listed = Named[] | { data: Named[] } | Record<string, unknown>;

/** Ids of everything seeded, by kind and name, so shots can link to a specific record. */
export type SeedState = Record<string, Record<string, string>>;

/**
 * Seeds the demo organization through the API as an admin. Additive and
 * idempotent: existing records (matched by name) are reused, nothing is deleted.
 */
export async function seedDemoData(api: ArchestraApi): Promise<SeedState> {
  await api.post("/api/organization/complete-onboarding", {
    onboardingComplete: true,
  });

  const state: SeedState = {};
  const record = (kind: string, name: string, id: string) => {
    state[kind] ??= {};
    state[kind][name] = id;
  };

  // Records an earlier run created as someone else move to the persona.
  const session = await api.get<{
    user: { id: string };
    session: { activeOrganizationId: string };
  }>("/api/auth/get-session");
  const ownerId = session.user.id;
  record("organization", "id", session.session.activeOrganizationId);
  record("users", "persona", ownerId);
  const own = (path: string) =>
    api.tryPost(`${path}/transfer-ownership`, { ownerId });

  for (const team of TEAMS) {
    const created = await api.ensureNamed({
      name: team.name,
      list: async () => items(await api.get<Listed>("/api/teams?limit=100")),
      create: () => api.post<Named>("/api/teams", team),
    });
    record("teams", team.name, created.id);
  }

  for (const environment of ENVIRONMENTS) {
    const created = await api.ensureNamed({
      name: environment.name,
      list: async () => items(await api.get<Listed>("/api/environments")),
      create: () => api.post<Named>("/api/environments", environment),
    });
    record("environments", environment.name, created.id);
  }

  const agents = async () => items(await api.get<Listed>("/api/agents?limit=100"));
  for (const agent of AGENTS) {
    const created = await api.ensureNamed({
      name: agent.name,
      list: agents,
      create: () => api.post<Named>("/api/agents", { ...agent, agentType: "agent" }),
    });
    record("agents", agent.name, created.id);
    await own(`/api/agents/${created.id}`);
  }
  for (const gateway of MCP_GATEWAYS) {
    const created = await api.ensureNamed({
      name: gateway.name,
      list: agents,
      create: () =>
        api.post<Named>("/api/agents", { ...gateway, agentType: "mcp_gateway" }),
    });
    record("gateways", gateway.name, created.id);
    await own(`/api/agents/${created.id}`);
  }

  for (const server of REMOTE_MCP_SERVERS) {
    const created = await api.ensureNamed({
      name: server.name,
      list: async () => items(await api.get<Listed>("/api/internal_mcp_catalog")),
      create: () =>
        api.post<Named>("/api/internal_mcp_catalog", {
          ...server,
          serverType: "remote",
        }),
    });
    record("catalog", server.name, created.id);
    await own(`/api/internal_mcp_catalog/${created.id}`);
  }

  for (const knowledgeBase of KNOWLEDGE_BASES) {
    const created = await api.ensureNamed({
      name: knowledgeBase.name,
      list: async () => items(await api.get<Listed>("/api/knowledge-bases?limit=100")),
      create: () => api.post<Named>("/api/knowledge-bases", knowledgeBase),
    });
    record("knowledgeBases", knowledgeBase.name, created.id);
  }

  for (const project of PROJECTS) {
    const created = await api.ensureNamed({
      name: project.name,
      list: async () => items(await api.get<Listed>("/api/projects")),
      create: () => api.post<Named>("/api/projects", project),
    });
    record("projects", project.name, created.id);
    await own(`/api/projects/${created.id}`);
  }

  for (const skill of SKILLS) {
    const created = await api.ensureNamed({
      name: skill.name,
      list: async () => items(await api.get<Listed>("/api/skills?limit=100")),
      create: () => api.post<Named>("/api/skills", { content: skill.content }),
    });
    record("skills", skill.name, created.id);
    await own(`/api/skills/${created.id}`);
  }

  // Plugins are keyed by displayName rather than name.
  const plugins = async () =>
    items(await api.get<Listed>("/api/plugins")).map((item) => {
      const { id, displayName } = item as unknown as { id: string; displayName: string };
      return { id, name: displayName };
    });
  for (const plugin of PLUGINS) {
    const created = await api.ensureNamed({
      name: plugin.displayName,
      list: plugins,
      create: async () => {
        const { id } = await api.post<{ id: string }>("/api/plugins", plugin);
        return { id, name: plugin.displayName };
      },
    });
    record("plugins", plugin.displayName, created.id);
    await own(`/api/plugins/${created.id}`);
  }

  const limitEntityType = {
    organization: "organization",
    teams: "team",
    environments: "environment",
  } as const;
  const existingLimits = items(
    await api.get<Listed>("/api/limits"),
  ) as unknown as { entityType: string; entityId: string }[];
  for (const limit of LIMITS) {
    const entityType = limitEntityType[limit.entity];
    const entityId = state[limit.entity][limit.name];
    if (existingLimits.some((l) => l.entityType === entityType && l.entityId === entityId)) {
      continue;
    }
    await api.post("/api/limits", {
      entityType,
      entityId,
      limitType: "token_cost",
      limitValue: limit.dollars,
      model: null,
      cleanupInterval: "calendar_month",
    });
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SEED_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function readSeedState(): SeedState {
  return JSON.parse(fs.readFileSync(SEED_STATE_FILE, "utf8")) as SeedState;
}
