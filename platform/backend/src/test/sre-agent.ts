import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { McpServerModel, ToolModel } from "@/models";
import { sreAgentService } from "@/services/sre-agent";
import {
  SRE_AGENT_TOOL_NAMES,
  SRE_CATALOG_ID,
  SRE_SERVER_NAME,
} from "@/services/sre-agent/definition";

export const SRE_SERVICE_ACCOUNT = "archestra-mcp-k8s-operator";

/** Turns the feature on, with `apiServerCidrs` as the Kubernetes API server. */
export function enableSre(apiServerCidrs: string[]): void {
  config.sreAgent.enabled = true;
  config.sreAgent.k8sServiceAccount = SRE_SERVICE_ACCOUNT;
  config.sreAgent.apiServerCidrs = apiServerCidrs;
  config.skillsSandbox.enabled = false;
}

interface AdminFixtures<U extends { id: string }> {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<U>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides: { role: string },
  ) => Promise<unknown>;
}

export async function seedAdmin<U extends { id: string }>(
  fixtures: AdminFixtures<U>,
): Promise<{ organizationId: string; admin: U }> {
  const organization = await fixtures.makeOrganization();
  const admin = await fixtures.makeUser();
  await fixtures.makeMember(admin.id, organization.id, {
    role: ADMIN_ROLE_NAME,
  });
  return { organizationId: organization.id, admin };
}

/** The seeded catalog item and its org-wide install, before tool discovery. */
export async function seedSreInstall<U extends { id: string }>(
  fixtures: AdminFixtures<U>,
) {
  const { organizationId, admin } = await seedAdmin(fixtures);
  await sreAgentService.seed();
  const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
  const ensureAgent = () =>
    sreAgentService.ensureAgent({
      organizationId,
      authorId: admin.id,
      mcpServerId: server.id,
    });
  return { organizationId, admin, server, ensureAgent };
}

/** The seeded install with every SRE tool discovered, and the agent. */
export async function seedSreAgent<U extends { id: string }>(
  fixtures: AdminFixtures<U>,
) {
  const install = await seedSreInstall(fixtures);
  const tools = await discoverTools(SRE_AGENT_TOOL_NAMES);
  await install.ensureAgent();
  return { ...install, tools };
}

/** The rows tool discovery writes for the server's advertised tools. */
export function discoverTools(rawNames: readonly string[]) {
  return ToolModel.bulkCreateToolsIfNotExists(
    rawNames.map((rawName) => ({
      name: ToolModel.slugifyName(SRE_SERVER_NAME, rawName),
      rawToolName: rawName,
      description: `Kubernetes ${rawName}`,
      parameters: { type: "object", properties: {} },
      catalogId: SRE_CATALOG_ID,
    })),
  );
}
