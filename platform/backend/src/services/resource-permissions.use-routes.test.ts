// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type ChatMessage,
  type ResourcePermissionGrant,
  TOOL_LOAD_SKILL_FULL_NAME,
} from "@archestra/shared";
import type { TestAPI } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import SkillModel from "@/models/skill";
import { injectSkillActivation } from "@/routes/chat/inject-skill-activation";
import chatRoutes from "@/routes/chat/routes";
import mcpServerRoutes from "@/routes/mcp-server";
import { accessGrants, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { drainBackgroundWork } from "@/utils/background-work";

type Fixtures = Pick<
  typeof test extends TestAPI<infer Context> ? Context : never,
  | "makeOrganization"
  | "makeUser"
  | "makeMember"
  | "makeAgent"
  | "makeConversation"
  | "makeInternalMcpCatalog"
  | "makeKnowledgeBase"
  | "makeSecret"
  | "makeLlmProviderApiKey"
>;

/**
 * The `use` action, through the paths that ask for it. A grant's presets are
 * View (`read`), Use (`read`, `use`) and up. Reading an object must not be
 * enough to use it.
 *
 * Four callers, all plain members:
 * - `user` holds the Use preset on each object.
 * - `viewer` holds the View preset on each object.
 * - `stranger` holds no grant.
 * - `member` holds no grant of their own, and each object has a twin whose
 *   organization-wide grant is the Use preset.
 */
describe("the use action after the upgrade", () => {
  test("chat with an agent or a gateway, and installing from the registry, ask for use", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeConversation,
    makeInternalMcpCatalog,
    makeKnowledgeBase,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const world = await seedUseWorld({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeConversation,
      makeInternalMcpCatalog,
      makeKnowledgeBase,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const app = await authenticatedRouteApp({
      organizationId: world.organizationId,
      routes: [chatRoutes, mcpServerRoutes],
    });

    // A caller past the `use` check goes on to the model or the server, and
    // neither is reachable here: chat stops at 503 and an install at 502.
    // Those statuses mean the check let the caller through.
    const expected: Record<CallerName, Record<RoutePath, number>> = {
      user: { agentChat: 503, gatewayChat: 503, registryInstall: 502 },
      viewer: { agentChat: 403, gatewayChat: 403, registryInstall: 403 },
      // The registry hides an entry the caller cannot read, so the install
      // finds no entry.
      stranger: { agentChat: 403, gatewayChat: 403, registryInstall: 400 },
      member: { agentChat: 503, gatewayChat: 503, registryInstall: 502 },
    };

    const actual: Record<string, Record<string, number>> = {};
    for (const who of Object.keys(expected) as CallerName[]) {
      const caller = world.callers[who];
      const headers = { [USER_HEADER]: caller.id };
      const target = world.targetsFor(who);
      const chat = async (agentId: string) => {
        const conversation = await makeConversation(agentId, {
          userId: caller.id,
          organizationId: world.organizationId,
        });
        const response = await app.inject({
          method: "POST",
          url: "/api/chat",
          headers,
          payload: {
            id: conversation.id,
            messages: [
              { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
            ],
          },
        });
        return response.statusCode;
      };
      const install = await app.inject({
        method: "POST",
        url: "/api/mcp_server",
        headers,
        payload: { name: `install-${who}`, catalogId: target.catalog },
      });
      actual[who] = {
        agentChat: await chat(target.agent),
        gatewayChat: await chat(target.gateway),
        registryInstall: install.statusCode,
      };
    }
    await app.close();
    expect(actual).toEqual(expected);
  });

  test("querying a knowledge base, activating a skill and chat key choice ask for use", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeConversation,
    makeInternalMcpCatalog,
    makeKnowledgeBase,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const world = await seedUseWorld({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeConversation,
      makeInternalMcpCatalog,
      makeKnowledgeBase,
      makeSecret,
      makeLlmProviderApiKey,
    });

    const expected: Record<CallerName, Record<GateName, boolean>> = {
      user: {
        knowledgeQuery: true,
        skillActivation: true,
        skillLoad: true,
        providerKey: true,
      },
      viewer: {
        knowledgeQuery: false,
        skillActivation: false,
        skillLoad: false,
        providerKey: false,
      },
      stranger: {
        knowledgeQuery: false,
        skillActivation: false,
        skillLoad: false,
        providerKey: false,
      },
      member: {
        knowledgeQuery: true,
        skillActivation: true,
        skillLoad: true,
        providerKey: true,
      },
    };

    const actual: Record<string, Record<string, boolean>> = {};
    for (const who of Object.keys(expected) as CallerName[]) {
      const caller = world.callers[who];
      const target = world.targetsFor(who);
      const accessControl =
        await knowledgeSourceAccessControlService.buildAccessControlContext({
          organizationId: world.organizationId,
          userId: caller.id,
        });
      const knowledgeBase = world.knowledgeBases[target.knowledgeBase];
      const skill = await SkillModel.findById(target.skill);
      if (!skill) throw new Error("missing skill");
      const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        world.organizationId,
        caller.id,
        [],
        "anthropic",
      );
      actual[who] = {
        knowledgeQuery:
          knowledgeSourceAccessControlService.canQueryKnowledgeBase(
            accessControl,
            knowledgeBase,
          ),
        skillActivation: await activatesSkill({
          organizationId: world.organizationId,
          userId: caller.id,
          skill,
        }),
        skillLoad: await loadsSkill({
          organizationId: world.organizationId,
          userId: caller.id,
          agent: world.contextAgent,
          skillName: skill.name,
        }),
        providerKey: available.some((key) => key.id === target.providerKey),
      };
    }
    expect(actual).toEqual(expected);
  });
});

// ===

type CallerName = "user" | "viewer" | "stranger" | "member";
type RoutePath = "agentChat" | "gatewayChat" | "registryInstall";
type GateName =
  | "knowledgeQuery"
  | "skillActivation"
  | "skillLoad"
  | "providerKey";

const USE: ResourcePermissionGrant["actions"] = ["read", "use"];
const VIEW: ResourcePermissionGrant["actions"] = ["read"];

async function seedUseWorld(fx: Fixtures) {
  const org = await fx.makeOrganization();
  const author = await fx.makeUser();
  const callers = {
    user: await fx.makeUser(),
    viewer: await fx.makeUser(),
    stranger: await fx.makeUser(),
    member: await fx.makeUser(),
  };
  for (const user of [author, ...Object.values(callers)]) {
    await fx.makeMember(user.id, org.id);
  }
  const direct: ResourcePermissionGrant[] = [
    { subject: { type: "user", id: callers.user.id }, actions: USE },
    { subject: { type: "user", id: callers.viewer.id }, actions: VIEW },
  ];
  const everyone: ResourcePermissionGrant[] = [
    { subject: { type: "organization", id: "*" }, actions: USE },
  ];

  const secret = await fx.makeSecret();
  const pair = async <T extends { id: string }>(
    resource:
      | "agent"
      | "mcpGateway"
      | "mcpRegistry"
      | "knowledgeBase"
      | "skill"
      | "llmProviderApiKey",
    make: () => Promise<T>,
  ) => {
    const shared = await make();
    const published = await make();
    await setGrants({
      organizationId: org.id,
      resource,
      scope: shared.id,
      grants: direct,
    });
    await setGrants({
      organizationId: org.id,
      resource,
      scope: published.id,
      grants: everyone,
    });
    return { shared, published };
  };

  const agents = await pair("agent", () =>
    fx.makeAgent({
      organizationId: org.id,
      agentType: "agent",
      authorId: author.id,
      access: "personal",
    }),
  );
  const gateways = await pair("mcpGateway", () =>
    fx.makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      authorId: author.id,
      access: "personal",
    }),
  );
  const catalogs = await pair("mcpRegistry", () =>
    fx.makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: author.id,
      access: "personal",
      serverType: "remote",
      serverUrl: "http://127.0.0.1:9/mcp",
    }),
  );
  const knowledgeBases = await pair("knowledgeBase", () =>
    fx.makeKnowledgeBase(org.id, { createdBy: author.id }),
  );
  let skillCount = 0;
  const skills = await pair("skill", async () => {
    skillCount += 1;
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        authorId: author.id,
        name: `use-skill-${skillCount}`,
        description: "A skill to use",
        content: "# Instructions",
        sourceType: "manual",
      },
      files: [],
      ...accessGrants("personal"),
    });
    if (!skill) throw new Error("failed to seed skill");
    return skill;
  });
  const keys = await pair("llmProviderApiKey", () =>
    fx.makeLlmProviderApiKey(org.id, secret.id, { isPrimary: false }),
  );

  const pick = (published: boolean) =>
    ({
      agent: (published ? agents.published : agents.shared).id,
      gateway: (published ? gateways.published : gateways.shared).id,
      catalog: (published ? catalogs.published : catalogs.shared).id,
      knowledgeBase: published ? "published" : "shared",
      skill: (published ? skills.published : skills.shared).id,
      providerKey: (published ? keys.published : keys.shared).id,
    }) as const;

  return {
    organizationId: org.id,
    // The agent a skill tool runs under. Any agent of the organization does:
    // the tool asks about the caller, not the agent.
    contextAgent: { id: agents.published.id, name: agents.published.name },
    callers,
    knowledgeBases: {
      shared: knowledgeBases.shared,
      published: knowledgeBases.published,
    },
    targetsFor: (who: CallerName) => pick(who === "member"),
  };
}

async function setGrants(params: {
  organizationId: string;
  resource: Parameters<
    typeof ResourcePermissionPolicyModel.find
  >[0]["resource"];
  scope: string;
  grants: ResourcePermissionGrant[];
}) {
  const key = {
    organizationId: params.organizationId,
    resource: params.resource,
    scope: params.scope,
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  const replaced = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: params.grants,
  });
  if (!replaced) throw new Error(`failed to set grants on ${params.scope}`);
}

/**
 * Activate the skill by slash command, the way a chat turn does. Activation
 * rewrites the message, so an unchanged message means it was refused.
 */
async function activatesSkill(params: {
  organizationId: string;
  userId: string;
  skill: { id: string; name: string };
}) {
  const messages: ChatMessage[] = [
    {
      role: "user",
      parts: [{ type: "text", text: "go" }],
      metadata: { skill: { id: params.skill.id, name: params.skill.name } },
    },
  ];
  const result = await injectSkillActivation({
    messages,
    organizationId: params.organizationId,
    userId: params.userId,
    agentId: undefined,
    conversationId: undefined,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  await drainBackgroundWork();
  return result[0].parts?.[0]?.text !== "go";
}

/**
 * Load the skill with the `load_skill` tool, the way a model does in a chat
 * turn. A refused load returns an error result.
 */
async function loadsSkill(params: {
  organizationId: string;
  userId: string;
  agent: { id: string; name: string };
  skillName: string;
}) {
  const result = await executeArchestraTool(
    TOOL_LOAD_SKILL_FULL_NAME,
    { name: params.skillName },
    {
      agent: params.agent,
      organizationId: params.organizationId,
      userId: params.userId,
    },
  );
  return !result.isError;
}
