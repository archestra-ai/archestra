import type { TokenAuthContext } from "@/clients/mcp-client";
import {
  ExternalMcpSkillUsageEventModel,
  InternalMcpCatalogModel,
  McpCatalogSkillModel,
  McpServerModel,
  MemberModel,
  TeamModel,
} from "@/models";
import McpServerUserModel from "@/models/mcp-server-user";
import { readExternalMcpSkill } from "@/skills/mcp-external";
import type {
  ExternalMcpSkillDetail,
  ExternalMcpSkillListItem,
  McpServer,
  ToolOwner,
} from "@/types";

export async function listExternalMcpSkills(params: {
  userId?: string;
  organizationId: string;
  isMcpServerAdmin: boolean;
  environmentId?: string | null;
}): Promise<ExternalMcpSkillListItem[]> {
  const servers = (
    await McpServerModel.findAll(
      params.userId,
      params.isMcpServerAdmin,
      params.organizationId,
      params.environmentId,
    )
  ).filter(
    (server) =>
      isExternalSkillServer(server) &&
      (params.userId !== undefined || server.scope === "org"),
  );
  const catalogIds = [
    ...new Set(
      servers
        .map((server) => server.catalogId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const [skills, catalogIcons] = await Promise.all([
    McpCatalogSkillModel.findByCatalogIds(catalogIds),
    InternalMcpCatalogModel.getIconsByIds(catalogIds),
  ]);
  const skillsByCatalog = new Map<string, typeof skills>();
  for (const skill of skills) {
    const catalogSkills = skillsByCatalog.get(skill.catalogId) ?? [];
    catalogSkills.push(skill);
    skillsByCatalog.set(skill.catalogId, catalogSkills);
  }

  const projected = servers.flatMap((server) =>
    (server.catalogId ? (skillsByCatalog.get(server.catalogId) ?? []) : []).map(
      (skill) => ({
        source: "external_mcp" as const,
        id: skill.id,
        catalogId: skill.catalogId,
        mcpServerId: server.id,
        scope: server.scope,
        serverName: server.name,
        icon: catalogIcons.get(skill.catalogId) ?? null,
        name: skill.name,
        description: skill.description,
        uri: skill.uri,
        resources: skill.resources,
      }),
    ),
  );
  const usageSummaries = await ExternalMcpSkillUsageEventModel.getSummaries(
    projected.map(({ mcpServerId, uri }) => ({ mcpServerId, uri })),
  );
  const result = projected.map((skill) => {
    const usage = usageSummaries.get(skill.mcpServerId)?.get(skill.uri);
    return {
      ...skill,
      usageCount: usage?.usageCount ?? 0,
      usageUserCount: usage?.usageUserCount ?? 0,
      lastUsedAt: usage?.lastUsedAt ?? null,
    };
  });
  return result.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.serverName.localeCompare(b.serverName) ||
      a.mcpServerId.localeCompare(b.mcpServerId),
  );
}

export async function getExternalMcpSkill(params: {
  id: string;
  mcpServerId: string;
  userId?: string;
  organizationId: string;
  isMcpServerAdmin: boolean;
  environmentId?: string | null;
  owner?: ToolOwner;
  tokenAuth?: TokenAuthContext;
}): Promise<ExternalMcpSkillDetail | null> {
  const listed = await listExternalMcpSkills(params);
  const metadata = listed.find(
    (skill) =>
      skill.id === params.id && skill.mcpServerId === params.mcpServerId,
  );
  if (!metadata) return null;
  const live = await readExternalMcpSkill({
    mcpServerId: metadata.mcpServerId,
    uri: metadata.uri,
    owner: params.owner,
    tokenAuth: params.tokenAuth,
  });
  return { ...metadata, ...live };
}

export async function canReadExternalMcpSkillUsage(params: {
  mcpServerId: string;
  uri: string;
  userId: string;
  organizationId: string;
  isMcpServerAdmin: boolean;
}): Promise<boolean> {
  const server = await McpServerModel.findByIdInOrg(
    params.mcpServerId,
    params.organizationId,
  );
  if (
    !server ||
    !isExternalSkillServer(server) ||
    // An unowned, teamless installation cannot be attributed to one tenant;
    // never expose its user-level analytics across organization boundaries.
    (server.ownerId === null && server.teamId === null)
  ) {
    return false;
  }
  if (
    !(await isExternalSkillInstallationInOrganization({
      server,
      organizationId: params.organizationId,
    }))
  ) {
    return false;
  }
  if (!(await canReadExternalSkillServer({ server, ...params }))) return false;

  return (
    (await McpCatalogSkillModel.findByCatalogIdAndUri({
      catalogId: server.catalogId,
      uri: params.uri,
    })) !== null
  );
}

function isExternalSkillServer(server: McpServer): boolean {
  return (
    server.catalogId !== null &&
    (server.serverType === "local" || server.serverType === "remote")
  );
}

async function canReadExternalSkillServer(params: {
  server: McpServer;
  userId: string;
  isMcpServerAdmin: boolean;
}): Promise<boolean> {
  switch (params.server.scope) {
    case "personal":
      return McpServerUserModel.userHasPersonalMcpServerAccess(
        params.userId,
        params.server.id,
      );
    case "team":
      return (
        params.isMcpServerAdmin ||
        (params.server.teamId !== null &&
          (await TeamModel.isUserInTeam(params.server.teamId, params.userId)))
      );
    case "org":
      return true;
    default:
      return false;
  }
}

async function isExternalSkillInstallationInOrganization(params: {
  server: McpServer;
  organizationId: string;
}): Promise<boolean> {
  if (params.server.teamId !== null) {
    const team = await TeamModel.findById(params.server.teamId);
    return team?.organizationId === params.organizationId;
  }
  if (params.server.ownerId === null) return false;

  const organizationIds = await MemberModel.findOrganizationIdsByUserId(
    params.server.ownerId,
  );
  return (
    organizationIds.length === 1 && organizationIds[0] === params.organizationId
  );
}
