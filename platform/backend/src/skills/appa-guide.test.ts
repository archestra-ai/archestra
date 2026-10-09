import { readFileSync } from "node:fs";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import { syncBuiltInSkillsForOrganization } from "@/database/seed";
import { SkillModel } from "@/models";
import AgentSkillModel from "@/models/agent-skill";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { inspectOpenAppaPolicyTests } from "@/services/openappa-policy-tests";
import { describe, expect, test } from "@/test";
import { APPA_GUIDE_SKILL } from "./appa-guide";
import {
  APPA_CONTRACTS_PARTS,
  appaContractsPartPath,
} from "./appa-guide-contracts";
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
    for (const { path } of APPA_GUIDE_SKILL.files) {
      const reference = await executeArchestraTool(
        "archestra__load_skill",
        { name: APPA_GUIDE_SKILL.name, path },
        context,
      );
      expect(reference.isError).not.toBe(true);
    }
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
    const reference = APPA_GUIDE_SKILL.files.find(
      (file) => file.path === "references/archestra.md",
    )?.content;
    if (!reference) throw new Error("Archestra reference not found");
    const [fallback, declarations] = [
      ...reference.matchAll(/```toml\n([\s\S]*?)```/g),
    ].map((match) => match[1]);
    const header =
      "[policy]\nversion = 2\n\n[policy.deployment]\ncontext_control = true\n";
    expect(initialPolicy()).toContain(
      "[policy.deployment]\ncontext_control = true",
    );
    const binding =
      '\n[externals.annotators.noop]\nurl = "http://127.0.0.1:9000/api/guardrails-policy/annotators/noop"\n';
    for (const candidate of [
      header + fallback + binding,
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

  test("binds battery credentials with the bind tool, never a [credentials] line", () => {
    const reference = APPA_GUIDE_SKILL.files.find(
      (file) => file.path === "references/archestra.md",
    )?.content;
    if (!reference) throw new Error("Archestra reference not found");
    for (const text of [APPA_GUIDE_SKILL.content, reference]) {
      expect(text).toContain("archestra__bind_guardrails_credential");
      // A text line wins over the stored binding and locks it in the UI.
      for (const [, toml] of text.matchAll(/```toml\n([\s\S]*?)```/g))
        expect(toml).not.toContain("[credentials]");
      expect(text).not.toContain("`[server_aliases]`, and `[credentials]`");
      expect(text).not.toContain("`[server_aliases]` and `[credentials]`");
    }
    expect(APPA_GUIDE_SKILL.content).toContain(
      "overrides the stored binding and locks it in the Batteries dialog; do not add one",
    );
  });

  test("inlines OpenAPPA's shared policy-writing rules into the always-loaded skill body", () => {
    const core = readFileSync(
      new URL("./appa-guide.core.generated.md", import.meta.url),
      "utf8",
    );
    expect(APPA_GUIDE_SKILL.content).toContain(core);
    expect(
      APPA_GUIDE_SKILL.files.some((file) => file.content.includes(core)),
    ).toBe(false);
  });

  test("validation-writing examples parse with the embedded scenario parser", async () => {
    config.openappa.enabled = true;
    const reference = APPA_GUIDE_SKILL.files.find(
      (file) => file.path === "references/validation-writing.md",
    );
    if (!reference) throw new Error("Validation-writing reference is missing");
    const examples = [...reference.content.matchAll(/```appa\n([\s\S]*?)```/g)];
    expect(examples.length).toBeGreaterThan(0);
    const inspection = await inspectOpenAppaPolicyTests(
      examples.map((example, index) => ({
        path: `traces/example-${index}.appa`,
        content: example[1],
      })),
    );
    for (const file of inspection.files) {
      expect(file.error, file.path).toBeNull();
      expect(file.assertionCount).toBeGreaterThan(0);
    }
  });

  test("the validation example isolates the read restriction and catches its removal", async () => {
    const reference = APPA_GUIDE_SKILL.files.find(
      (file) => file.path === "references/validation-writing.md",
    )?.content;
    if (!reference) throw new Error("Validation-writing reference is missing");
    const policy = reference.match(/```toml\n([\s\S]*?)```/)?.[1];
    const scenario = reference.match(/```appa\n([\s\S]*?)```/)?.[1];
    if (!policy || !scenario) throw new Error("Validation example is missing");
    const { replayOpenappaPolicy } = await import("@archestra/openappa-rs");
    const replay = async (content: string) =>
      JSON.parse(
        await replayOpenappaPolicy(
          JSON.stringify({
            content,
            files: [{ path: "traces/private-read.appa", content: scenario }],
          }),
        ),
      ).files[0];

    const baseline = await replay(policy);
    expect(baseline.status).toBe("passed");
    expect(
      baseline.steps.map((step: { actual: string }) => step.actual),
    ).toEqual(["allow", "allow", "deny"]);

    const unprotected = await replay(
      policy.replace('delta = { audience = ["internal"] }', "delta = {}"),
    );
    expect(unprotected.status).toBe("failed");
    expect(unprotected.steps.at(-1)).toMatchObject({
      expected: "deny",
      actual: "allow",
    });

    const alwaysBlocked = await replay(
      policy.replace(
        'contains = ["public"] } }',
        'contains = ["public"] }, attention = ["blocked"] }',
      ),
    );
    expect(alwaysBlocked.status).toBe("failed");
    expect(alwaysBlocked.steps[0]).toMatchObject({
      expected: "allow",
      actual: "deny",
    });
  });

  test("every file the skill points to is bundled with it", () => {
    const bundled = new Set(APPA_GUIDE_SKILL.files.map((file) => file.path));
    const referenced = [
      APPA_GUIDE_SKILL.content,
      ...APPA_GUIDE_SKILL.files.map((file) => file.content),
    ].flatMap((text) => [...text.matchAll(/references\/[\w/-]+\.md/g)]);
    for (const [path] of referenced) {
      expect(bundled, path).toContain(path);
    }
  });

  test("the served contracts parts rebuild OpenAPPA's policy reference", () => {
    const upstream = readFileSync(
      new URL("./appa-guide.contracts.generated.md", import.meta.url),
      "utf8",
    );
    const starts = APPA_CONTRACTS_PARTS.flatMap(({ slug, headings }) =>
      headings.map((heading) => {
        const at = upstream.indexOf(`\n${heading}\n`) + 1;
        expect(at, heading).toBeGreaterThan(0);
        expect(upstream.indexOf(`\n${heading}\n`, at), heading).toBe(-1);
        return { slug, at };
      }),
    ).sort((a, b) => a.at - b.at);
    // Only the website frontmatter and intro precede the first part.
    expect(upstream.slice(0, starts[0].at)).not.toMatch(/^## /m);
    const expected = new Map<string, string>();
    starts.forEach(({ slug, at }, index) => {
      const section = upstream.slice(at, starts[index + 1]?.at);
      expected.set(slug, (expected.get(slug) ?? "") + section);
    });
    const served = new Map(
      APPA_GUIDE_SKILL.files.map((file) => [file.path, file.content]),
    );
    for (const { slug } of APPA_CONTRACTS_PARTS) {
      const part = served.get(appaContractsPartPath(slug));
      expect(
        part?.replaceAll(/\]\(references\/contracts\/[\w-]+\.md#/g, "](#"),
        slug,
      ).toBe(expected.get(slug)?.replaceAll(/\[([^\]]+)\]\(\/[^)]*\)/g, "$1"));
    }
  });
});
