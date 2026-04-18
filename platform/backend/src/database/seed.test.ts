import {
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
  POLICY_CONFIG_SYSTEM_PROMPT,
} from "@shared";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import { describe, expect, test } from "@/test";
import { syncBuiltInAgents } from "./seed";

describe("syncBuiltInAgents", () => {
  test("creates built-in agents for every organization", async ({
    makeOrganization,
  }) => {
    const firstOrg = await makeOrganization();
    const secondOrg = await makeOrganization();

    await syncBuiltInAgents();

    const [firstPolicyAgent, secondPolicyAgent] = await Promise.all([
      AgentModel.getBuiltInAgent(BUILT_IN_AGENT_IDS.POLICY_CONFIG, firstOrg.id),
      AgentModel.getBuiltInAgent(
        BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        secondOrg.id,
      ),
    ]);

    expect(firstPolicyAgent).not.toBeNull();
    expect(secondPolicyAgent).not.toBeNull();
  });

  test("updates legacy policy configuration system prompts", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();

    await db.insert(schema.agentsTable).values({
      organizationId: organization.id,
      name: BUILT_IN_AGENT_NAMES.POLICY_CONFIG,
      agentType: "agent",
      scope: "org",
      description:
        "Analyzes tool metadata with AI to generate deterministic security policies for handling untrusted data",
      systemPrompt: LEGACY_POLICY_CONFIG_SYSTEM_PROMPT,
      builtInAgentConfig: {
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolDiscovery: false,
      },
    });

    await syncBuiltInAgents();

    const builtInAgent = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.POLICY_CONFIG,
      organization.id,
    );

    expect(builtInAgent?.systemPrompt).toBe(POLICY_CONFIG_SYSTEM_PROMPT);
  });

  test("does not overwrite customized policy configuration prompts", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const customPrompt = "Custom policy configuration instructions";

    await db.insert(schema.agentsTable).values({
      organizationId: organization.id,
      name: BUILT_IN_AGENT_NAMES.POLICY_CONFIG,
      agentType: "agent",
      scope: "org",
      description:
        "Analyzes tool metadata with AI to generate deterministic security policies for handling untrusted data",
      systemPrompt: customPrompt,
      builtInAgentConfig: {
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolDiscovery: false,
      },
    });

    await syncBuiltInAgents();

    const builtInAgent = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.POLICY_CONFIG,
      organization.id,
    );

    expect(builtInAgent?.systemPrompt).toBe(customPrompt);
  });
});

const LEGACY_POLICY_CONFIG_SYSTEM_PROMPT = `Analyze this MCP tool and determine security policies:

Tool: {tool.name}
Description: {tool.description}
MCP Server: {mcpServerName}
Parameters: {tool.parameters}

Determine:

1. toolInvocationAction (enum) - When should this tool be allowed?
   - "allow_when_context_is_untrusted": Safe to invoke even with untrusted data (read-only, doesn't leak sensitive data)
   - "block_when_context_is_untrusted": Only invoke when context is trusted (could leak data if untrusted input is present)
   - "block_always": Never invoke automatically (writes data, executes code, sends data externally)

2. trustedDataAction (enum) - How should the tool's results be treated?
   - "mark_as_trusted": Internal systems (databases, APIs, dev tools like list-endpoints/get-config)
   - "mark_as_untrusted": External/filesystem data where exact values are safe to use directly
   - "sanitize_with_dual_llm": Untrusted data that needs summarization without exposing exact values
   - "block_always": Highly sensitive or dangerous output that should be blocked entirely

Examples:
- Internal dev tools: invocation="allow_when_context_is_untrusted", result="mark_as_trusted"
- Database queries: invocation="allow_when_context_is_untrusted", result="mark_as_trusted"
- File reads (code/config): invocation="allow_when_context_is_untrusted", result="mark_as_untrusted"
- Web search/scraping: invocation="allow_when_context_is_untrusted", result="sanitize_with_dual_llm"
- File writes: invocation="block_always", result="mark_as_trusted"
- External APIs (raw data): invocation="block_when_context_is_untrusted", result="mark_as_untrusted"
- Code execution: invocation="block_always", result="mark_as_untrusted"`;
