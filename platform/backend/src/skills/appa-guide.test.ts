import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import { syncBuiltInSkillsForOrganization } from "@/database/seed";
import { SkillModel } from "@/models";
import AgentSkillModel from "@/models/agent-skill";
import {
  guardrailsPolicyService,
  INITIAL_POLICY,
} from "@/services/guardrails-policy";
import { describe, expect, test } from "@/test";
import { APPA_GUIDE_SKILL } from "./appa-guide";
import { builtInSkillSourceRef } from "./built-in-skills";
import { buildSkillCatalogPrompt } from "./skill-catalog-prompt";

const sourceRef = builtInSkillSourceRef(APPA_GUIDE_SKILL.builtInSkillId);

describe("APPA Guide feature availability", () => {
  test("seeds only when APPA is enabled and loads its instructions and reference through agent tools", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const context = {
      organizationId: org.id,
      userId: user.id,
      agent: { id: agent.id, name: agent.name },
    };
    config.openappa.enabled = false;
    await syncBuiltInSkillsForOrganization(org);
    expect(
      await SkillModel.findBuiltIn({ organizationId: org.id, sourceRef }),
    ).toBeNull();
    config.openappa.enabled = true;
    await syncBuiltInSkillsForOrganization(org);
    const skill = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef,
    });
    expect(skill).not.toBeNull();
    // Published to the organization by its grants (checked just below).
    const published = await SkillModel.findOrgScopedInEnvironment({
      organizationId: org.id,
      environmentId: null,
      excludedForAgentId: agent.id,
      limit: 100,
    });
    expect(published.some((entry) => entry.id === skill?.id)).toBe(true);
    expect(
      await buildSkillCatalogPrompt({
        organizationId: org.id,
        userId: user.id,
        agentId: agent.id,
      }),
    ).toContain(APPA_GUIDE_SKILL.name);
    const loaded = await executeArchestraTool(
      "archestra__load_skill",
      { name: APPA_GUIDE_SKILL.name },
      context,
    );
    expect(loaded.isError).not.toBe(true);
    expect(JSON.stringify(loaded)).toContain(
      "archestra__get_guardrails_policy",
    );
    const reference = await executeArchestraTool(
      "archestra__load_skill",
      { name: APPA_GUIDE_SKILL.name, path: "references/policy-writing.md" },
      context,
    );
    expect(reference.isError).not.toBe(true);
    expect(JSON.stringify(reference)).toContain("Writing OpenAPPA policies");
    const contracts = await executeArchestraTool(
      "archestra__load_skill",
      { name: APPA_GUIDE_SKILL.name, path: "references/contracts.md" },
      context,
    );
    expect(contracts.isError).not.toBe(true);
    expect(JSON.stringify(contracts)).toContain(
      "OpenAPPA policy configuration and contracts reference",
    );
  });

  test("disabling APPA hides persisted and assigned guides without deleting user edits", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    config.openappa.enabled = true;
    await syncBuiltInSkillsForOrganization(org);
    const skill = await SkillModel.findBuiltIn({
      organizationId: org.id,
      sourceRef,
    });
    if (!skill) throw new Error("Guide was not seeded");
    const content = `${skill.content}\nOrganization-specific guidance.\n`;
    await SkillModel.updateWithFiles({ id: skill.id, skill: { content } });
    await AgentSkillModel.replaceAssignments({
      agentId: agent.id,
      skillIds: [skill.id],
    });
    config.openappa.enabled = false;
    await syncBuiltInSkillsForOrganization(org);
    expect(await SkillModel.findById(skill.id)).toBeNull();
    expect(await SkillModel.findByIds([skill.id])).toEqual([]);
    expect(await SkillModel.findManifestSourceById(skill.id)).toBeNull();
    expect(
      (
        await SkillModel.findOrgScopedInEnvironment({
          organizationId: org.id,
          environmentId: null,
          excludedForAgentId: agent.id,
          limit: 100,
        })
      ).some((entry) => entry.id === skill.id),
    ).toBe(false);
    expect(
      await SkillModel.findByOrganization({
        organizationId: org.id,
        search: APPA_GUIDE_SKILL.name,
      }),
    ).toEqual([]);
    expect(
      await SkillModel.countByOrganization({
        organizationId: org.id,
        search: APPA_GUIDE_SKILL.name,
      }),
    ).toBe(0);
    expect(await AgentSkillModel.findSkillIdsByAgent(agent.id)).toEqual([]);
    expect(
      await buildSkillCatalogPrompt({
        organizationId: org.id,
        userId: user.id,
        agentId: agent.id,
      }),
    ).not.toContain(APPA_GUIDE_SKILL.name);
    const loaded = await executeArchestraTool(
      "archestra__load_skill",
      { name: APPA_GUIDE_SKILL.name },
      {
        organizationId: org.id,
        userId: user.id,
        agent: { id: agent.id, name: agent.name },
      },
    );
    expect(loaded.isError).toBe(true);
    config.openappa.enabled = true;
    await syncBuiltInSkillsForOrganization(org);
    expect((await SkillModel.findById(skill.id))?.content).toBe(content);
    expect(await AgentSkillModel.findSkillIdsByAgent(agent.id)).toEqual([
      skill.id,
    ]);
  });

  test("policy examples compile with the embedded APPA version", async ({
    makeOrganization,
  }) => {
    config.openappa.enabled = true;
    const organizationId = (await makeOrganization()).id;
    const reference = APPA_GUIDE_SKILL.files[0].content;
    const blocks = [...reference.matchAll(/```toml\n([\s\S]*?)```/g)].map(
      (match) => match[1],
    );
    const [header, read, write, fallback, remote, declarations] = blocks;
    expect(blocks).toHaveLength(6);
    expect(header).toContain("[policy.deployment]\ncontext_control = true");
    expect(INITIAL_POLICY).toContain(
      "[policy.deployment]\ncontext_control = true",
    );
    const binding =
      '\n[externals.annotators.noop]\nurl = "http://127.0.0.1:9000/api/guardrails-policy/annotators/noop"\n';
    for (const candidate of [
      header,
      header + read,
      header + write,
      header + fallback + binding,
      header + remote,
      // Declarations are root-level keys, so they precede the first table.
      declarations + header,
    ]) {
      expect(
        await guardrailsPolicyService.validate(candidate, { organizationId }),
      ).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      });
    }

    const contracts = APPA_GUIDE_SKILL.files.find(
      (f) => f.path === "references/contracts.md",
    );
    expect(contracts).toBeDefined();
    if (!contracts) throw new Error("contracts not found");
    const contractBlocks = [
      ...contracts.content.matchAll(/```toml\n([\s\S]*?)```/g),
    ].map((match) => match[1]);
    for (const candidate of contractBlocks) {
      expect(
        await guardrailsPolicyService.validate(candidate, { organizationId }),
      ).toEqual({
        valid: true,
        errors: [],
        warnings: [],
      });
    }
  });

  test("verifies full parity with openappa native claude code plugin integration (P01-P15)", () => {
    const content = APPA_GUIDE_SKILL.content;

    // Frontmatter and argument hint
    expect(content).toMatch(/^---\nname: appa-guide\n/);
    expect(content).toContain('argument-hint: "init|adjust"');
    expect(content).toContain("Guardrails v2 (OpenAPPA)");

    // Modes
    expect(content).toContain("**`init`**");
    expect(content).toContain("**`adjust`**");
    expect(content).toContain("diagnose");
    expect(content).toContain("inspect only");
    expect(content).toContain("show policy");

    // Init 4-step text plan
    expect(content).toContain(
      "I am starting the initial OpenAPPA setup. Here is what I will do:",
    );
    expect(content).toContain(
      "1. Scan your active agents, tool servers, and MCP tools.",
    );
    expect(content).toContain(
      "2. Check the OpenAPPA runtime policy and available security batteries.",
    );
    expect(content).toContain(
      "3. Match discovered tools against security rules.",
    );
    expect(content).toContain(
      "4. Present a tailored policy proposal for your review and approval.",
    );
    expect(content).toContain("Starting inspection now...");

    // P01: Canonical router and host guidance
    expect(content).toContain("archestra__get_guardrails_policy");
    expect(content).toContain("archestra__preview_guardrails_policy_change");
    expect(content).toContain("archestra__update_guardrails_policy");
    expect(content).toContain("archestra__get_guardrails_policy_change_status");

    // P02: Complete host inventory before proposal
    expect(content).toContain("archestra__list_mcp_server_deployments");
    expect(content).toContain("archestra__get_mcp_server_tools");
    expect(content).toContain("archestra__search_tools");

    // P03: Root config and serving policy as truth
    expect(content).toContain(
      "The root config is the operator's source of truth",
    );
    expect(content).toContain("effective.content");

    // P04: Distinguish available, matched, and included batteries with declarations
    expect(content).toContain("A battery is available when it exists");
    expect(content).toContain("It is declared by `include`");
    expect(content).toContain("under 20 words");
    expect(content).toContain("effective.batteries");
    expect(content).toContain("include");

    // P05: Generate IFC-first defaults
    expect(content).toContain("IFC monoids first");
    expect(content).toContain('delta = { audience = ["self"] }');
    expect(content).toContain('delta = { audience = ["internal"] }');
    expect(content).toContain(
      'requires = { audience = { contains = ["public"] } }',
    );
    expect(content).toContain(
      'requires = { trust = "trusted", audience = { contains = ["internal"] } }',
    );

    // P06: Read-only inspection & complete proposal before approval
    expect(content).toContain(
      "Inspection and proposal drafting never require approval",
    );
    expect(content).toContain(
      "End with: **Approve, or tell me what to change.**",
    );

    // P07: Approval applies only to exact pending proposal; never invent offer id
    expect(content).toContain("Never invent an offer id");
    expect(content).toContain(
      "Call `execute_remedy_plan` only when the previous tool result quoted `offer_id",
    );

    // P08: Revalidate immediately before mutation
    expect(content).toContain("expectedRevision");
    expect(content).toContain("preview the exact approved draft again");
    expect(content).toContain("the PR merges and repository sync succeeds");

    // P09: No-change result performs no write or reload and uses no approval language
    expect(content).toContain(
      "If the current config already provides the complete proposed behavior",
    );
    expect(content).toContain("report that no change is needed");

    // P10: User-facing replies report outcomes, not inspection mechanics
    expect(content).toContain("Talk about outcomes, not config machinery");
    expect(content).toContain("OpenAPPA pieces: <primitives>");

    // P11: Sensitive inspection is least privilege
    expect(content).toContain("Keep secrets out of policy text");

    // P12: Unsupported host behavior is explicit and cannot be described as protected
    expect(content).toContain(
      "Without the catch-all, declare `archestra__search_tools` with `delta = {}`",
    );
    expect(content).toContain(
      "every proxied request fails closed without retry",
    );

    // P13: Multi-runtime / session isolation
    expect(content).toContain(
      "Saved policies apply to new conversations. This conversation keeps",
    );
    expect(content).toContain("policy it started with.");

    // P14: Battery inclusion preserves maintained defaults; root overrides
    expect(content).toContain("Never edit a battery.");
    expect(content).toContain("Override a tool contract with a root rule");

    // P15: Battery credentials live in runtime environment, never in policy
    expect(content).toContain("token_env");
    expect(content).toContain("[credentials]");

    // A saved policy replaces the initial policy; init must keep native spawn support.
    expect(content).toContain(
      "A saved revision replaces the complete document",
    );
    expect(content).toContain("host/archestra/task");
    expect(content).toContain("context_control = true");

    // Provider-hosted calls do not become governed just because a rule names them.
    expect(content).toContain("Ask which clients use provider-hosted tools");
    expect(content).toContain("signed offer to use a local counterpart");
    const contracts = APPA_GUIDE_SKILL.files.find(
      (file) => file.path === "references/contracts.md",
    );
    expect(contracts?.content).toContain("### Provider-hosted tools");
    expect(contracts?.content).toContain("no supported policy switch");
  });
});
