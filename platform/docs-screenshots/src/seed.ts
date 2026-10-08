import fs from "node:fs";
import { type ArchestraApi, items } from "./api";
import {
  AGENT_HOOKS,
  AGENTS,
  ENVIRONMENTS,
  KNOWLEDGE_BASES,
  KNOWLEDGE_DIRECTORIES,
  KNOWLEDGE_FILES,
  LIMITS,
  MCP_GATEWAYS,
  PLUGINS,
  PROJECTS,
  REMOTE_MCP_SERVERS,
  SKILLS,
  TEAMS,
  PROVIDER_KEYS,
} from "./dataset";
import { SEED_STATE_FILE, STATE_DIR } from "./env";
import { textPdf } from "./pdf";

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

  for (const hook of AGENT_HOOKS) {
    const agentId = state.agents?.[hook.agentName];
    if (!agentId) continue;
    const existingHooks = items(
      await api.get<Listed>(`/api/hooks?agentId=${agentId}`),
    ) as unknown as { id: string; fileName: string; event: string }[];
    const existing = existingHooks.find(
      (h) => h.fileName === hook.fileName && h.event === hook.event,
    );
    if (!existing) {
      const created = await api.post<{ id: string }>("/api/hooks", {
        agentId,
        event: hook.event,
        fileName: hook.fileName,
        content: hook.content,
        requirements: hook.requirements,
        enabled: hook.enabled,
      });
      record("hooks", `${hook.agentName}:${hook.fileName}`, created.id);
    } else {
      await api.put(`/api/hooks/${existing.id}`, {
        event: hook.event,
        fileName: hook.fileName,
        content: hook.content,
        requirements: hook.requirements,
        enabled: hook.enabled,
      });
      record("hooks", `${hook.agentName}:${hook.fileName}`, existing.id);
    }
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

  const existingProviderKeys = items(await api.get<Listed>("/api/llm-provider-api-keys"));
  for (const providerKey of PROVIDER_KEYS) {
    const created =
      existingProviderKeys.find((key) => key.name === providerKey.name) ??
      (await api.tryPost<Named>("/api/llm-provider-api-keys", providerKey));
    if (created) {
      record("providerKeys", providerKey.name, created.id);
    } else {
      console.warn(`Skipped provider key "${providerKey.name}": the provider rejected the fake key.`);
    }
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

/**
 * Uploads the Knowledge Files and indexes them into their Knowledge Bases.
 * Runs after the database seed, because indexing needs the embedding model it
 * sets. A file that already exists is left as it is.
 */
export async function seedKnowledgeFiles(api: ArchestraApi, state: SeedState): Promise<void> {
  const directories: Record<string, string> = {};
  for (const name of KNOWLEDGE_DIRECTORIES) {
    const created = await api.ensureNamed({
      name,
      list: async () => items(await api.get<Listed>("/api/knowledge-directories")),
      create: () => api.post<Named>("/api/knowledge-directories", { name }),
    });
    directories[name] = created.id;
  }

  type Stored = { id: string; filename: string; knowledgeBases?: { id: string }[] };
  const stored = async () => items(await api.get<Listed>("/api/knowledge-files?limit=100")) as unknown as Stored[];
  const existing = new Set((await stored()).map((file) => file.filename));
  for (const file of KNOWLEDGE_FILES) {
    if (existing.has(file.filename)) continue;
    const pdf = file.filename.endsWith(".pdf");
    const mimeType = pdf ? "application/pdf" : file.filename.endsWith(".csv") ? "text/csv" : "text/markdown";
    const bytes = pdf ? textPdf(file.text) : Buffer.from(file.text);
    const upload = {
      filename: file.filename,
      mimeType,
      content: bytes.toString("base64"),
      directoryId: file.directory ? directories[file.directory] : null,
    };
    // The server's PDF parser sometimes rejects a valid file, so retry it.
    let created: { id: string } | null = null;
    for (let attempt = 0; attempt < 8 && !created; attempt++) {
      created = await api.tryPost<{ id: string }>("/api/knowledge-files", upload);
    }
    if (!created) throw new Error(`Could not upload ${file.filename}`);
  }

  // Index every file that is not yet in its Knowledge Base, new or left by an
  // earlier run. Indexing parses each PDF again, so retry what the parser rejects.
  for (let attempt = 0; attempt < 8; attempt++) {
    const byName = new Map((await storedEverywhere()).map((file) => [file.filename, file]));
    const toIndex: Record<string, string[]> = {};
    for (const file of KNOWLEDGE_FILES) {
      const row = byName.get(file.filename);
      const baseId = file.knowledgeBase && state.knowledgeBases[file.knowledgeBase];
      if (!row || !baseId || row.knowledgeBases?.some((base) => base.id === baseId)) continue;
      (toIndex[baseId] ??= []).push(row.id);
    }
    if (Object.keys(toIndex).length === 0) return;
    for (const [knowledgeBaseId, fileIds] of Object.entries(toIndex)) {
      await api.post("/api/knowledge-files/index", { fileIds, knowledgeBaseId });
    }
  }
  console.warn("Some Knowledge Files could not be indexed.");

  // The listing shows one directory at a time, so read each directory too.
  async function storedEverywhere(): Promise<Stored[]> {
    const lists = await Promise.all(
      Object.values(directories).map(
        async (id) => items(await api.get<Listed>(`/api/knowledge-files?limit=100&directoryId=${id}`)) as unknown as Stored[],
      ),
    );
    return [...(await stored()), ...lists.flat()];
  }
}

export function readSeedState(): SeedState {
  return JSON.parse(fs.readFileSync(SEED_STATE_FILE, "utf8")) as SeedState;
}
