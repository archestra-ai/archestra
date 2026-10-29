import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { afterEach, beforeEach, vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import { seedDocsMcpServers } from "@/database/seed-docs-mcp-servers";
import { AgentModel, McpServerModel } from "@/models";
import AgentSuggestedPromptModel from "@/models/agent-suggested-prompt";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { getDocsSuggestedPrompts } from "./docs-mcp-servers";

const OPENAPPA_DOCS_ID = "00000000-0000-4000-8000-000000000004";
const BOTH_TITLES = [
  "What can Archestra do?",
  "How does OpenAPPA protect agents?",
];

const DOCS_TOOLS = ["list_docs", "read_doc", "search_docs"].map((name) => ({
  name,
  description: `Docs tool ${name}`,
  inputSchema: { type: "object", properties: {} },
}));

describe("getDocsSuggestedPrompts", () => {
  beforeEach(() => {
    config.enterpriseFeatures.core = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("offers both prompts on the caller's own assistant", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { org, admin } = await seedDocsServers({
      makeOrganization,
      makeUser,
      makeMember,
    });

    expect(
      await titlesFor({ userId: admin.id, organizationId: org.id }),
    ).toEqual(BOTH_TITLES);
  });

  test("offers them to a member, not only the admin", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { org } = await seedDocsServers({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });

    expect(
      await titlesFor({ userId: member.id, organizationId: org.id }),
    ).toEqual(BOTH_TITLES);
  });

  test("offers nothing on an agent that is not the caller's assistant", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { org, admin, agentId } = await seedDocsServers({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const shared = await makeAgent({
      organizationId: org.id,
      authorId: admin.id,
      accessAllTools: true,
    });

    expect(
      await getDocsSuggestedPrompts({
        agent: await loadAgent(shared.id),
        userId: admin.id,
        organizationId: org.id,
      }),
    ).toEqual([]);
    expect(
      await getDocsSuggestedPrompts({
        agent: await loadAgent(agentId),
        userId: member.id,
        organizationId: org.id,
      }),
    ).toEqual([]);
  });

  test("offers nothing when the assistant has prompts of its own", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { org, admin, agentId } = await seedDocsServers({
      makeOrganization,
      makeUser,
      makeMember,
    });
    await AgentSuggestedPromptModel.syncForAgent({
      agentId,
      prompts: [{ summaryTitle: "Mine", prompt: "My own prompt" }],
    });

    expect(
      await titlesFor({ userId: admin.id, organizationId: org.id }),
    ).toEqual([]);
  });

  test("drops the prompt of a server that was uninstalled", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { org, admin } = await seedDocsServers({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const [install] = await McpServerModel.findByCatalogId(OPENAPPA_DOCS_ID);
    await McpServerModel.delete(install.id);

    expect(
      await titlesFor({ userId: admin.id, organizationId: org.id }),
    ).toEqual(["What can Archestra do?"]);
  });
});

async function seedDocsServers(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    options: { role: string },
  ) => Promise<unknown>;
}) {
  const org = await fixtures.makeOrganization();
  const admin = await fixtures.makeUser();
  await fixtures.makeMember(admin.id, org.id, { role: ADMIN_ROLE_NAME });
  const agentId = (await AgentModel.ensurePersonalChatAgent({
    userId: admin.id,
    organizationId: org.id,
  })) as string;
  vi.spyOn(mcpClient, "connectAndGetTools").mockResolvedValue(DOCS_TOOLS);
  await seedDocsMcpServers();
  await drainBackgroundWork();
  return { org, admin, agentId };
}

async function titlesFor(params: { userId: string; organizationId: string }) {
  const agentId = (await AgentModel.ensurePersonalChatAgent(params)) as string;
  const prompts = await getDocsSuggestedPrompts({
    agent: await loadAgent(agentId),
    ...params,
  });
  return prompts.map((prompt) => prompt.summaryTitle);
}

async function loadAgent(agentId: string) {
  const agent = await AgentModel.findById(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  return agent;
}
