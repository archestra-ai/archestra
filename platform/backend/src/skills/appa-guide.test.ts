import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import { syncBuiltInSkillsForOrganization } from "@/database/seed";
import { SkillModel } from "@/models";
import AgentSkillModel from "@/models/agent-skill";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
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
    expect(skill?.scope).toBe("org");
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
  });
});
