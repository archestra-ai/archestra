import fs from "node:fs";
import { sql } from "drizzle-orm";
import db from "@/database";
import {
  AgentModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { describe, expect, test } from "@/test";

const migration = fs.readFileSync(
  new URL("./0465_claude_native_credentials.sql", import.meta.url),
  "utf8",
);

describe("native Claude credential migration", () => {
  test("preserves GitHub secrets and bindings, removes only native Claude token declarations, and is repeatable", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const unusedOrganization = await makeOrganization();
    const bindingOrganization = await makeOrganization();
    const user = await makeUser();
    const connection = await RuntimeCredentialConnectionModel.upsert({
      organizationId: organization.id,
      userId: user.id,
      credentialId: "github",
      scope: "personal",
      value: "preserved-test-pat",
    });
    const github = {
      key: "GITHUB_TOKEN",
      credentialId: "github",
      scope: "per_user" as const,
      label: "GitHub",
      required: false,
    };
    const legacyClaude = {
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      scope: "per_user" as const,
      label: "Claude",
      required: true,
    };
    const runtime = {
      image: "example.test/claude-code:latest",
      command: ["archestra-claude-code"],
      inferenceProtocol: "anthropic" as const,
      backend: "kubernetes" as const,
      steerMode: "tmux_keys" as const,
      privileged: false,
      resources: null,
      environment: null,
      credentials: [github, legacyClaude],
      ttlHours: null,
      idleTimeoutMinutes: null,
    };
    const agent = await makeAgent({
      organizationId: bindingOrganization.id,
      runtime,
    });
    const custom = await makeAgent({
      organizationId: organization.id,
      runtime: { ...runtime, command: ["custom-harness"] },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const statement of migration.split("--> statement-breakpoint"))
        await db.execute(sql.raw(statement));
      expect(
        await RuntimeCredentialDefinitionModel.list(organization.id),
      ).toMatchObject([
        { key: "github", allowPersonal: true, allowOrganization: false },
      ]);
      expect(
        await RuntimeCredentialDefinitionModel.list(bindingOrganization.id),
      ).toMatchObject([{ key: "github" }]);
      expect(
        await RuntimeCredentialDefinitionModel.list(unusedOrganization.id),
      ).toEqual([]);
      expect(
        await RuntimeCredentialConnectionModel.findForAudit({
          organizationId: organization.id,
          userId: user.id,
          credentialId: "github",
          scope: "personal",
        }),
      ).toMatchObject({ id: connection.id });
      expect(
        await RuntimeCredentialConnectionModel.resolveValue({
          organizationId: organization.id,
          userId: user.id,
          credentialId: "github",
          scope: "personal",
        }),
      ).toBe("preserved-test-pat");
      expect(
        (await AgentModel.findById(agent.id))?.runtime?.credentials,
      ).toEqual([github]);
      expect(
        (await AgentModel.findById(custom.id))?.runtime?.credentials,
      ).toEqual([github, legacyClaude]);
    }
  });
});
