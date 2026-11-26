import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { EnvironmentModel, SkillModel } from "@/models";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createEnvironment } from "@/services/environments/environment";
import { MAX_SKILL_FILE_BYTES } from "@/skills/github-import";
import { describe, expect, test } from "@/test";
import { createRestrictedEnvironment } from "@/test/environments";
import skillRoutes from "./skill.routes";
import {
  MANIFEST,
  manifestNamed,
  seedImportedSkill,
  useSkillRouteTestApp,
} from "./skill.test-helpers";

describe("POST /api/skills", () => {
  const ctx = useSkillRouteTestApp(skillRoutes);

  test("creates a skill from a SKILL.md manifest", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe("pdf-processing");
    expect(body.description).toBe("Extract text from PDF files.");
    expect(body.content).toContain("# PDF Processing");
    expect(body.sourceType).toBe("manual");
    expect(body.authorId).toBe(ctx.user.id);
    expect(body.files).toEqual([]);
  });

  test("persists explicit environment assignments (one or several)", async () => {
    const staging = await createEnvironment({
      organizationId: ctx.organizationId,
      data: { name: "Staging" },
    });
    const production = await createEnvironment({
      organizationId: ctx.organizationId,
      data: { name: "Production" },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        environmentIds: [staging.id, production.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .environments.map((e: { id: string; name: string }) => e.name)
        .sort(),
    ).toEqual(["Production", "Staging"]);
  });

  test("omitting environments creates a skill available everywhere", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environments).toEqual([]);
  });

  test("assigning a restricted environment requires skill:deploy-to-restricted", async () => {
    const open = await createEnvironment({
      organizationId: ctx.organizationId,
      data: { name: "Open" },
    });
    const restricted = await createRestrictedEnvironment({
      organizationId: ctx.organizationId,
      data: { name: "Restricted" },
    });
    // members hold skill:create but not skill:deploy-to-restricted
    await MemberModel.updateRole(
      ctx.user.id,
      ctx.organizationId,
      MEMBER_ROLE_NAME,
    );

    // one restricted environment anywhere in the set rejects the whole create
    const denied = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        environmentIds: [open.id, restricted.id],
      },
    });
    expect(denied.statusCode).toBe(403);

    // an unrestricted set is fine for the same user
    const allowed = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("open-env-skill"),
        environmentIds: [open.id],
      },
    });
    expect(allowed.statusCode).toBe(200);
  });

  test("rejects an environment from another organization", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignEnv = await EnvironmentModel.create({
      organizationId: otherOrg.id,
      name: "Foreign",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST, environmentIds: [foreignEnv.id] },
    });

    expect(response.statusCode).toBe(404);
  });

  test("stores resource files with derived kinds", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        files: [
          { path: "references/FORMS.md", content: "# Forms" },
          { path: "scripts/run.py", content: "print(1)" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const files = response.json().files;
    expect(files).toHaveLength(2);
    const byPath = Object.fromEntries(
      files.map((f: { path: string; kind: string }) => [f.path, f.kind]),
    );
    expect(byPath["references/FORMS.md"]).toBe("reference");
    expect(byPath["scripts/run.py"]).toBe("script");
  });

  test("derives allowedTools from frontmatter when the payload omits it", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("pdf-processing", "allowed-tools: Read Bash"),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowedTools).toBe("Read Bash");
  });

  test("explicit allowedTools overrides the frontmatter", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("pdf-processing", "allowed-tools: Read"),
        allowedTools: ["Bash", "Edit"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowedTools).toBe("Bash Edit");
  });

  test("an empty allowedTools array clears the frontmatter value", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: manifestNamed("pdf-processing", "allowed-tools: Read"),
        allowedTools: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowedTools).toBeNull();
  });

  test("rejects a manifest with no frontmatter", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: "# no frontmatter" },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects a duplicate skill name", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST },
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST },
    });

    expect(response.statusCode).toBe(409);
  });

  test("rejects a name that differs from one of the author's skills only by letter case", async () => {
    // A new name is lowercase by rule, so the other spelling can only be a
    // stored one: saved before the rule was asked, or imported from Git.
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      name: "Probe-Skill-One",
      sourceRef: "example/skills@main:skills/probe",
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: manifestNamed("probe-skill-one") },
    });

    expect(response.statusCode).toBe(409);
    // Names the skill that is in the way, as it is actually spelled.
    expect(response.json().error.message).toContain('"Probe-Skill-One"');
    expect(response.json().error.message).toContain("letter case");
  });

  test("another author may hold the same name in a different letter case", async ({
    makeUser,
  }) => {
    const other = await makeUser();
    await seedImportedSkill({
      organizationId: ctx.organizationId,
      authorId: other.id,
      name: "Shared-Name",
      sourceRef: "example/skills@main:skills/shared",
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: manifestNamed("shared-name") },
    });

    expect(response.statusCode).toBe(200);
  });

  // One rule and one sentence for every new name: the Agent Skills naming
  // rules. A name they refuse is not stored and then left out of a gateway.
  test.each([
    ["a slash", "name: docs/release"],
    ["a line break", 'name: "two\\nlines"'],
    ["a parent-directory step", 'name: "up..over"'],
    ["more than 64 characters", `name: ${"x".repeat(65)}`],
    ["a space and capitals", 'name: "Release Notes"'],
    ["an emoji", 'name: "notes ✍️"'],
    ["an underscore", "name: pdf_tools"],
    ["a leading hyphen", 'name: "-pdf"'],
    ["two hyphens in a row", "name: pdf--tools"],
  ])("rejects a new name with %s", async (_label, nameLine) => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: ["---", nameLine, "description: A skill.", "---", ""].join(
          "\n",
        ),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "This name can't be used. Skill name can only contain lowercase letters, digits and single hyphens, up to 64 characters.",
    );
  });

  test("rejects a description longer than the Agent Skills specification takes", async () => {
    const create = (description: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: [
            "---",
            "name: long-description",
            `description: ${description}`,
            "---",
            "",
          ].join("\n"),
        },
      });

    const refused = await create("d".repeat(1025));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe(
      "This description is too long. Skill description can be up to 1024 characters.",
    );
    expect((await create("d".repeat(1024))).statusCode).toBe(200);
  });

  test("a manifest YAML cannot read is refused with one plain line", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: [
          "---",
          "name: release-notes",
          "description: Use when: the user asks",
          "---",
          "",
        ].join("\n"),
      },
    });

    expect(response.statusCode).toBe(400);
    const message: string = response.json().error.message;
    expect(message).toContain("wrap it in quotes");
    // The whole message is shown in a toast: no parser code frame.
    expect(message).not.toContain("\n");
  });

  test("a name YAML reads as a number is told to be text", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: ["---", "name: 123", "description: A skill.", "---", ""].join(
          "\n",
        ),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("`name` must be text");
  });

  test("rejects duplicate resource file paths with a 400", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        files: [
          { path: "references/FORMS.md", content: "# Forms" },
          { path: "references/FORMS.md", content: "# Dup" },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects absolute and traversing resource file paths", async () => {
    for (const path of ["/absolute.md", "references/../secrets.md"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path, content: "x" }],
        },
      });

      expect(response.statusCode, path).toBe(400);
    }
  });

  test("still accepts paths the MCP gateway cannot publish", async () => {
    // Publishing wants paths that round-trip through a skill:// URI, and a
    // top-level SKILL.md would be shadowed by the served manifest. Neither is
    // enforced at input: a skill stored under an older rule must stay editable,
    // so the gateway withholds it instead of the API refusing the save.
    const paths = [
      "references//double.md",
      "references/./here.md",
      "trailing/",
      "SKILL.md",
    ];
    for (const [index, path] of paths.entries()) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        // one skill per path: names are unique within an organization
        payload: {
          content: manifestNamed(`unpublishable-${index}`),
          files: [{ path, content: "x" }],
        },
      });

      expect(response.statusCode, path).toBe(200);
    }
  });

  test("rejects non-canonical base64 file content", async () => {
    // Decoders disagree on non-canonical base64 (`QQ==QQ==` is two bytes to
    // Postgres, one to Node, an error to Python), so a digest over it could
    // never verify for every client. Canonical spellings — what every platform
    // writer emits — are accepted; anything else is refused at the door.
    for (const content of ["QQ==QQ==", "QQ==\nQQ==", "QUJD====", "QU!JD"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "assets/blob.bin", content, encoding: "base64" }],
        },
      });
      expect(response.statusCode, JSON.stringify(content)).toBe(400);
    }

    const canonical = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        content: MANIFEST,
        files: [
          {
            path: "assets/blob.bin",
            content: Buffer.from("real bytes").toString("base64"),
            encoding: "base64",
          },
        ],
      },
    });
    expect(canonical.statusCode).toBe(200);
  });

  test("rejects a manifest larger than the size cap", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: MANIFEST + "x".repeat(MAX_SKILL_FILE_BYTES) },
    });

    expect(response.statusCode).toBe(400);
  });

  describe("scope", () => {
    test("a new skill defaults to personal scope owned by the author", async () => {
      const body = (
        await ctx.app.inject({
          method: "POST",
          url: "/api/skills",
          payload: { content: MANIFEST },
        })
      ).json();

      expect(body.scope).toBe("personal");
      expect(body.authorId).toBe(ctx.user.id);
      expect(body.teams).toEqual([]);
    });

    test("refuses the retired scope, teamIds and userIds fields", async () => {
      for (const retired of [
        { scope: "org" },
        { teamIds: [] },
        { userIds: [ctx.user.id] },
      ]) {
        const response = await ctx.app.inject({
          method: "POST",
          url: "/api/skills",
          payload: { content: MANIFEST, ...retired },
        });
        expect(response.statusCode).toBe(400);
      }
      expect(
        await SkillModel.findAllByName(ctx.organizationId, "pdf-processing"),
      ).toHaveLength(0);
    });

    test("admins can publish a new skill to the organization with a grant", async () => {
      await MemberModel.updateRole(
        ctx.user.id,
        ctx.organizationId,
        ADMIN_ROLE_NAME,
      );

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          initialGrants: [
            {
              subject: { type: "organization", id: "*" },
              actions: ["read", "use"],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(await grantSubjects(response.json().id)).toContain(
        "organization:*",
      );
    });

    test("creators share a new skill with teams they do not belong to", async ({
      makeTeam,
      makeTeamMember,
    }) => {
      await MemberModel.updateRole(
        ctx.user.id,
        ctx.organizationId,
        EDITOR_ROLE_NAME,
      );
      const ownTeam = await makeTeam(ctx.organizationId, ctx.user.id);
      await makeTeamMember(ownTeam.id, ctx.user.id);
      const foreignTeam = await makeTeam(ctx.organizationId, ctx.user.id);

      const ok = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("team-skill"),
          initialGrants: [
            {
              subject: { type: "team", id: ownTeam.id },
              actions: ["read", "use"],
            },
          ],
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(await grantSubjects(ok.json().id)).toContain(`team:${ownTeam.id}`);

      const shared = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("foreign-team-skill"),
          initialGrants: [
            {
              subject: { type: "team", id: foreignTeam.id },
              actions: ["read", "use"],
            },
          ],
        },
      });
      expect(shared.statusCode, shared.body).toBe(200);
      expect(await grantSubjects(shared.json().id)).toContain(
        `team:${foreignTeam.id}`,
      );
    });

    test("rejects a team-scoped skill with an unknown team id without orphaning it", async () => {
      await MemberModel.updateRole(
        ctx.user.id,
        ctx.organizationId,
        ADMIN_ROLE_NAME,
      );

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: manifestNamed("orphan-check"),
          initialGrants: [
            {
              subject: { type: "team", id: "does-not-exist" },
              actions: ["read", "use"],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      // the skill row must not have been committed
      expect(
        await SkillModel.findAllByName(ctx.organizationId, "orphan-check"),
      ).toHaveLength(0);
    });
  });
});

/** The `type:id` subjects of a skill's permission policy. */
async function grantSubjects(skillId: string): Promise<string[]> {
  const skill = await SkillModel.findById(skillId);
  if (!skill) throw new Error("skill not found");
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: skill.organizationId,
    resource: "skill",
    scope: skillId,
  });
  return (policy?.grants ?? []).map(
    (grant) => `${grant.subject.type}:${grant.subject.id}`,
  );
}
