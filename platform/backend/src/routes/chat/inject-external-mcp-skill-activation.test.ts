import type { ChatMessage } from "@archestra/shared";
import * as chatMcpClient from "@/clients/chat-mcp-client";
import config from "@/config";
import { ExternalMcpSkillUsageEventModel } from "@/models";
import * as externalMcpSkills from "@/services/external-mcp-skills";
import { afterEach, expect, test, vi } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { injectExternalMcpSkillActivation } from "./inject-skill-activation";

afterEach(() => vi.restoreAllMocks());

test("injects an attached external Skill without changing visible user text", async ({
  makeAgent,
  makeInternalMcpCatalog,
  makeMember,
  makeMcpServer,
  makeOrganization,
  makeUser,
}) => {
  const originalEnabled = config.mcpGateway.skillsEnabled;
  config.mcpGateway.skillsEnabled = true;
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const agent = await makeAgent({ organizationId: organization.id });
  const catalog = await makeInternalMcpCatalog({
    organizationId: organization.id,
  });
  const server = await makeMcpServer({
    catalogId: catalog.id,
    scope: "org",
    ownerId: user.id,
  });
  const skillId = crypto.randomUUID();
  const serverId = server.id;
  const uri = "skill://example/release/SKILL.md";
  vi.spyOn(chatMcpClient, "selectMCPGatewayToken").mockResolvedValue(null);
  const getExternalSkill = vi
    .spyOn(externalMcpSkills, "getExternalMcpSkill")
    .mockResolvedValue({
      source: "external_mcp",
      id: skillId,
      catalogId: crypto.randomUUID(),
      mcpServerId: serverId,
      scope: "org",
      serverName: "Operations server",
      icon: null,
      name: "release-checklist",
      description: "Verify a release.",
      uri,
      resources: [],
      usageCount: 0,
      usageUserCount: 0,
      lastUsedAt: null,
      content: "# Release\nRun the checks.",
      files: [
        {
          path: "guide.md",
          content: "Guide",
          encoding: "utf8",
          kind: "reference",
        },
      ],
    });
  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "Prepare tonight's release." }],
      metadata: {
        externalMcpSkill: {
          id: skillId,
          mcpServerId: serverId,
          uri,
          name: "release-checklist",
          serverName: "Operations server",
          commandValue: "/operations-server-release-checklist",
          displayName: "Operations server [org:12345678] / release-checklist",
        },
      },
    },
  ];

  try {
    const result = await injectExternalMcpSkillActivation({
      messages,
      organizationId: organization.id,
      userId: user.id,
      agentId: agent.id,
      conversationId: "conversation-1",
      provider: "openai",
      model: "gpt-5",
    });

    expect(result[0].parts?.[0]?.text).toContain(
      '<skill_content name="Operations server [org:',
    );
    expect(result[0].parts?.[0]?.text).toContain("Run the checks.");
    expect(result[0].parts?.[0]?.text).toContain("Prepare tonight's release.");
    expect(messages[0].parts?.[0]?.text).toBe("Prepare tonight's release.");
    expect(getExternalSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: skillId,
        mcpServerId: serverId,
        organizationId: organization.id,
        userId: user.id,
        environmentId: null,
      }),
    );

    await drainBackgroundWork();
    const usage = await ExternalMcpSkillUsageEventModel.getSummaries([
      { mcpServerId: serverId, uri },
    ]);
    expect(usage.get(serverId)?.get(uri)?.usageCount).toBe(1);
  } finally {
    config.mcpGateway.skillsEnabled = originalEnabled;
  }
});

test("rejects an external attachment whose catalog URI changed", async ({
  makeAgent,
  makeMember,
  makeOrganization,
  makeUser,
}) => {
  const originalEnabled = config.mcpGateway.skillsEnabled;
  config.mcpGateway.skillsEnabled = true;
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const agent = await makeAgent({ organizationId: organization.id });
  vi.spyOn(chatMcpClient, "selectMCPGatewayToken").mockResolvedValue(null);
  vi.spyOn(externalMcpSkills, "getExternalMcpSkill").mockResolvedValue({
    source: "external_mcp",
    id: crypto.randomUUID(),
    catalogId: crypto.randomUUID(),
    mcpServerId: crypto.randomUUID(),
    scope: "org",
    serverName: "Operations server",
    icon: null,
    name: "release-checklist",
    description: "Verify a release.",
    uri: "skill://example/new/SKILL.md",
    resources: [],
    usageCount: 0,
    usageUserCount: 0,
    lastUsedAt: null,
    content: "Changed source",
    files: [],
  });
  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "Keep this clean." }],
      metadata: {
        externalMcpSkill: {
          id: crypto.randomUUID(),
          mcpServerId: crypto.randomUUID(),
          uri: "skill://example/old/SKILL.md",
          name: "release-checklist",
          serverName: "Operations server",
          commandValue: "/operations-server-release-checklist",
          displayName: "Operations server [org:12345678] / release-checklist",
        },
      },
    },
  ];

  try {
    const result = await injectExternalMcpSkillActivation({
      messages,
      organizationId: organization.id,
      userId: user.id,
      agentId: agent.id,
      conversationId: "conversation-1",
      provider: "openai",
      model: "gpt-5",
    });
    expect(result).toBe(messages);
    expect(result[0].parts?.[0]?.text).toBe("Keep this clean.");
  } finally {
    config.mcpGateway.skillsEnabled = originalEnabled;
  }
});
