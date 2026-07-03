import {
  ARCHESTRA_TOOL_PREFIX,
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
  CHAT_TITLE_GENERATION_SYSTEM_PROMPT,
  CONTEXT_COMPACTION_SYSTEM_PROMPT,
  POLICY_CONFIG_SYSTEM_PROMPT,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import db, { schema } from "@/database";
import { OrganizationModel, SkillFileModel, SkillModel } from "@/models";
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

  test("upgrades the previous (pre-dual-llm) policy configuration prompt", async ({
    makeOrganization,
  }) => {
    // Seed from an independent local copy of the previous shipped prompt (below),
    // not the exported snapshot the migration matches against, so a future drift
    // between the two fails this test instead of silently skipping the upgrade.
    expect(PREVIOUS_POLICY_CONFIG_SYSTEM_PROMPT).not.toBe(
      POLICY_CONFIG_SYSTEM_PROMPT,
    );

    const organization = await makeOrganization();

    await db.insert(schema.agentsTable).values({
      organizationId: organization.id,
      name: BUILT_IN_AGENT_NAMES.POLICY_CONFIG,
      agentType: "agent",
      scope: "org",
      description:
        "Analyzes tool metadata with AI to generate deterministic security policies for handling untrusted data",
      systemPrompt: PREVIOUS_POLICY_CONFIG_SYSTEM_PROMPT,
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

// Independent copy of the previous shipped POLICY_CONFIG_SYSTEM_PROMPT (the
// revision before sanitize_with_dual_llm was restored), rendered with its
// Handlebars expressions resolved, exactly as existing orgs stored it. Kept
// separate from the shared snapshot so the migration test catches any drift.
const PREVIOUS_POLICY_CONFIG_SYSTEM_PROMPT = `Analyze this MCP tool and determine security policies.

The primary security goal is to PREVENT LEAKING SENSITIVE DATA FROM INTERNAL SYSTEMS TO EXTERNAL SERVICES. Internal systems (Jira, GitHub, databases, etc.) contain sensitive organizational data. External-facing tools (browsers, web scrapers, email senders, etc.) can transmit data outside the organization. Policies must ensure sensitive internal data never flows outward through external tools.

Tool: {{tool.name}}
Description: {{tool.description}}
MCP Server: {{mcpServerName}}
Parameters: {{tool.parameters}}
Annotations: {{tool.annotations}}

Determine two policies:

1. toolInvocationAction — Controls WHEN the tool may be invoked based on whether the conversation context contains sensitive data.
   - "allow_when_context_is_sensitive": The tool is safe to invoke even when the context contains sensitive data. Use for tools that CANNOT leak context externally — they only read from internal systems. Examples: internal API reads, database reads, self-hosted service integrations.
   - "block_when_context_is_sensitive": The tool must be BLOCKED when the context contains sensitive data because it could transmit that data externally. Use for tools that send data to external services or the open internet. Examples: browsers, web search, email, external APIs, code execution sandboxes.
   - "require_approval": The tool requires user confirmation before executing in chat; in autonomous agent sessions (A2A, API, MS Teams, subagents) the call is blocked. Use for tools that mutate state with non-trivial consequences but are NOT obviously destructive — create/update/send/post/charge operations on internal systems. Examples: jira__create_issue, github__merge_pr, email__send, payment__charge.
   - "block_always": The tool must NEVER be invoked automatically. Use for obviously destructive operations that delete or destroy data — see CRITICAL RULES below.

2. trustedDataAction — Controls HOW the tool's returned results are treated, based on whether they could contain sensitive or adversarial content.
   - "mark_as_safe": Results are fully trusted. Use only for internal dev/config tools returning non-sensitive metadata (e.g., list-endpoints, get-config, health checks).
   - "mark_as_sensitive": Results contain sensitive data that must be protected from leaking to external tools. Use for ANY tool that reads from internal self-hosted systems (Jira, GitHub, GitLab, Confluence, databases, internal APIs, file systems) — their results contain organizational data.
   - "block_always": Results are too dangerous to surface. Rarely used.

CRITICAL RULES:
- Obviously destructive tools → ALWAYS block_always invocation. A tool is obviously destructive ONLY if its NAME (not parameters or description) is solely dedicated to deleting or destroying data. Keywords in the tool name: delete, remove, destroy, drop, purge, truncate, erase, wipe. Multi-purpose tools that support destructive operations as one of several modes (e.g., a tool named "write" or "manage" that has a "remove" parameter option) are NOT obviously destructive — classify them based on their primary purpose.
- Mutating tools that are NOT obviously destructive → require_approval. Tool names with create/update/edit/modify/send/post/publish/charge/merge that change state in internal systems should require user approval rather than auto-execute.
- Read-only tools with annotations "readOnlyHint": true → safe for invocation, never block_always or require_approval unless they also have "destructiveHint": true.
- Internal self-hosted READ tools (Jira reads, GitHub reads, GitLab reads, Confluence reads, database reads, internal wikis) → allow_when_context_is_sensitive (safe to call) + mark_as_sensitive (results contain org data that must not leak).
- External-facing tools (browsers, Playwright, web search, email, external APIs) → block_when_context_is_sensitive (could leak context) + mark_as_safe (their results are controlled by us, not sensitive org data).

Examples — one per outcome; apply the rules above to classify any tool, not just these:
- jira__get_issue: invocation="allow_when_context_is_sensitive", result="mark_as_sensitive" (read-only internal)
- playwright__navigate: invocation="block_when_context_is_sensitive", result="mark_as_safe" (external-facing)
- jira__create_issue: invocation="require_approval", result="mark_as_sensitive" (mutating internal write, not destructive)
- email__send: invocation="require_approval", result="mark_as_safe" (sends data outward, needs human confirmation)
- database__drop_table: invocation="block_always", result="mark_as_safe" (destructive: name dedicated to deletion)`;

describe("syncBuiltInSkills", () => {
  // syncBuiltInSkills syncs branding per org; reset the singleton so it never
  // leaks an app name into a later (shuffled) test.
  afterEach(() => {
    archestraMcpBranding.syncFromOrganization(null);
  });

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

    const expected = BUILT_IN_SKILLS.length;
    expect(await countBuiltInSkills(org.id)).toBe(expected);
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

    // the squatted built-in is skipped (no phantom copy); the other built-ins
    // still seed.
    expect(await countBuiltInSkills(org.id)).toBe(BUILT_IN_SKILLS.length - 1);
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

  test("brands the seeded skill under the org's white-label app name", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, { appName: "Acme Copilot" });

    await syncBuiltInSkills();

    const skill = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef: builtInSkillSourceRef(BASE_SKILL.builtInSkillId),
    });
    // the stored row itself is branded, so every read path (catalog, load_skill,
    // sandbox mount) shows the app name with no per-read rewriting.
    expect(skill?.name).toBe("Acme Copilot Platform Operations");
    expect(skill?.content).not.toContain("Archestra");
    expect(skill?.content).not.toContain(ARCHESTRA_TOOL_PREFIX);
    // sourceCommit is hashed over the branded body, so a pristine branded copy
    // is recognised on re-sync (and re-brands if the app name later changes).
    expect(skill?.sourceCommit).not.toBe(builtInSkillVersion(BASE_SKILL));

    const files = await SkillFileModel.findBySkillId(skill?.id ?? "");
    for (const file of files) {
      expect(file.content).not.toContain("Archestra");
    }
  });

  test("re-brands a pristine copy when the app name changes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const sourceRef = builtInSkillSourceRef(BASE_SKILL.builtInSkillId);

    // first seed with no app name → canonical "Archestra" copy.
    await syncBuiltInSkills();
    const before = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef,
    });
    expect(before?.name).toBe("Archestra Platform Operations");

    // set an app name and re-sync — the untouched copy auto-upgrades to branded.
    await OrganizationModel.patch(org.id, { appName: "Acme Copilot" });
    await syncBuiltInSkills();

    const after = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef,
    });
    expect(after?.id).toBe(before?.id);
    expect(after?.name).toBe("Acme Copilot Platform Operations");
    expect(after?.content).not.toContain("Archestra");
  });

  test("seeds the build-app skill for every organization", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const buildAppRef = builtInSkillSourceRef("build-app");

    await syncBuiltInSkills();
    const seeded = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef: buildAppRef,
    });
    expect(seeded).not.toBeNull();
    expect(seeded?.content).toContain("window.archestra");
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
