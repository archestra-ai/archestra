import {
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
  CHAT_TITLE_GENERATION_SYSTEM_PROMPT,
  CONTEXT_COMPACTION_SYSTEM_PROMPT,
  POLICY_CONFIG_SYSTEM_PROMPT,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { afterEach } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { SkillFileModel, SkillModel } from "@/models";
import AgentModel from "@/models/agent";
import {
  BUILT_IN_SKILLS,
  builtInSkillSourceRef,
  builtInSkillVersion,
} from "@/skills/built-in-skills";
import { describe, expect, test } from "@/test";
import { decideEnvSeed, syncBuiltInAgents, syncBuiltInSkills } from "./seed";

const [BASE_SKILL] = BUILT_IN_SKILLS;

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

    const contextCompactionAgent = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION,
      firstOrg.id,
    );
    expect(contextCompactionAgent?.systemPrompt).toBe(
      CONTEXT_COMPACTION_SYSTEM_PROMPT,
    );

    const titleAgent = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION,
      firstOrg.id,
    );
    expect(titleAgent?.systemPrompt).toBe(CHAT_TITLE_GENERATION_SYSTEM_PROMPT);
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

describe("syncBuiltInSkills", () => {
  async function countBuiltInSkills(organizationId: string): Promise<number> {
    const rows = await db
      .select()
      .from(schema.skillsTable)
      .where(
        and(
          eq(schema.skillsTable.organizationId, organizationId),
          eq(schema.skillsTable.sourceType, "built_in"),
        ),
      );
    return rows.length;
  }

  test("seeds built-in skills with their files for every organization", async ({
    makeOrganization,
  }) => {
    const firstOrg = await makeOrganization();
    const secondOrg = await makeOrganization();

    await syncBuiltInSkills();

    const sourceRef = builtInSkillSourceRef(BASE_SKILL.builtInSkillId);
    for (const org of [firstOrg, secondOrg]) {
      const skill = await SkillModel.findBuiltIn({
        organizationId: org.id,
        sourceRef,
      });
      expect(skill).not.toBeNull();
      expect(skill?.scope).toBe("org");
      expect(skill?.authorId).toBeNull();
      expect(skill?.content).toBe(BASE_SKILL.content);

      const files = await SkillFileModel.findBySkillId(skill?.id ?? "");
      expect(files.map((file) => file.path).sort()).toEqual(
        BASE_SKILL.files.map((file) => file.path).sort(),
      );
    }
  });

  test("is idempotent across repeated runs", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await syncBuiltInSkills();
    await syncBuiltInSkills();

    expect(await countBuiltInSkills(org.id)).toBe(BUILT_IN_SKILLS.length);
  });

  test("does not seed a phantom copy when the name is already taken", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // a pre-existing shared skill squats on the built-in's display name.
    await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        scope: "org",
        name: BASE_SKILL.name,
        description: "user's own skill",
        content: "# not the built-in",
        sourceType: "manual",
      },
      files: [],
    });

    await syncBuiltInSkills();

    // no built-in row was created, and the squatting skill is untouched.
    expect(await countBuiltInSkills(org.id)).toBe(0);
    const built = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef: builtInSkillSourceRef(BASE_SKILL.builtInSkillId),
    });
    expect(built).toBeNull();
  });

  test("auto-upgrades a pristine copy when the shipped revision changes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const sourceRef = builtInSkillSourceRef(BASE_SKILL.builtInSkillId);

    // a stale-but-untouched copy: live content matches its stored version.
    const staleVersion = builtInSkillVersion({ content: "OLD", files: [] });
    await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        scope: "org",
        name: BASE_SKILL.name,
        description: "old description",
        content: "OLD",
        sourceType: "built_in",
        sourceRef,
        sourceCommit: staleVersion,
      },
      files: [],
    });

    await syncBuiltInSkills();

    const upgraded = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef,
    });
    expect(upgraded?.content).toBe(BASE_SKILL.content);
    expect(upgraded?.sourceCommit).toBe(builtInSkillVersion(BASE_SKILL));
    const files = await SkillFileModel.findBySkillId(upgraded?.id ?? "");
    expect(files).toHaveLength(BASE_SKILL.files.length);
  });

  test("preserves a copy the user has edited", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const sourceRef = builtInSkillSourceRef(BASE_SKILL.builtInSkillId);

    // an edited copy: live content diverges from its stored version.
    await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        scope: "org",
        name: BASE_SKILL.name,
        description: "user description",
        content: "EDITED BY USER",
        sourceType: "built_in",
        sourceRef,
        sourceCommit: builtInSkillVersion({ content: "OLD", files: [] }),
      },
      files: [],
    });

    await syncBuiltInSkills();

    const preserved = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef,
    });
    expect(preserved?.content).toBe("EDITED BY USER");
  });
});

describe("decideEnvSeed", () => {
  const originals = {
    vllm: config.llm.vllm.baseUrl,
    azure: config.llm.azure.baseUrl,
    openai: config.llm.openai.baseUrl,
    bedrock: config.llm.bedrock.baseUrl,
  };

  afterEach(() => {
    config.llm.vllm.baseUrl = originals.vllm;
    config.llm.azure.baseUrl = originals.azure;
    config.llm.openai.baseUrl = originals.openai;
    config.llm.bedrock.baseUrl = originals.bedrock;
  });

  test("skips vLLM when no base URL is configured", () => {
    config.llm.vllm.baseUrl = undefined;
    expect(decideEnvSeed("vllm").kind).toBe("skip");
  });

  test("creates vLLM with the base URL persisted when configured", () => {
    config.llm.vllm.baseUrl = "https://vllm.example.com/v1";
    expect(decideEnvSeed("vllm")).toEqual({
      kind: "create",
      persistedBaseUrl: "https://vllm.example.com/v1",
    });
  });

  test("skips Azure when no base URL is configured", () => {
    config.llm.azure.baseUrl = "";
    expect(decideEnvSeed("azure").kind).toBe("skip");
  });

  test("treats a whitespace-only base URL as not configured", () => {
    config.llm.azure.baseUrl = "   ";
    expect(decideEnvSeed("azure").kind).toBe("skip");
  });

  test("creates Azure with the base URL persisted when configured", () => {
    config.llm.azure.baseUrl = "https://my-resource.openai.azure.com/openai";
    expect(decideEnvSeed("azure")).toEqual({
      kind: "create",
      persistedBaseUrl: "https://my-resource.openai.azure.com/openai",
    });
  });

  test("creates a normal provider without persisting its base URL", () => {
    config.llm.openai.baseUrl = "https://api.openai.com/v1";
    expect(decideEnvSeed("openai")).toEqual({
      kind: "create",
      persistedBaseUrl: null,
    });
  });

  test("creates Bedrock without a base URL (region fallback)", () => {
    config.llm.bedrock.baseUrl = "";
    expect(decideEnvSeed("bedrock")).toEqual({
      kind: "create",
      persistedBaseUrl: null,
    });
  });
});
