import { describe, expect } from "vitest";
import { UserCredentialModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { test } from "@/test";
import type { RunnerCredentialDeclaration } from "@/types";
import {
  preflightRunnerCredentials,
  resolveRunnerCredentials,
} from "./credentials";
import { sanitizeRunnerConfigForWriter } from "./start-runner";

const CLAUDE_TOKEN: RunnerCredentialDeclaration = {
  key: "CLAUDE_CODE_OAUTH_TOKEN",
  scope: "per_user",
  label: "Claude Code OAuth token",
  description: "Run `claude setup-token` and paste the result",
  required: true,
};

const SHARED_API_KEY: RunnerCredentialDeclaration = {
  key: "SHARED_API_KEY",
  scope: "shared",
  label: "Shared API key",
  required: true,
};

function agentWith(
  credentials: RunnerCredentialDeclaration[],
  runnerSecretId: string | null = null,
) {
  return {
    id: "agent-id",
    runnerConfig: {
      steerMode: "pipe" as const,
      privileged: false,
      credentials,
      environment: [],
    },
    runnerSecretId,
  };
}

describe("resolveRunnerCredentials", () => {
  test("a user without their personal credential is told what to supply", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const resolved = await resolveRunnerCredentials({
      agent: agentWith([CLAUDE_TOKEN]),
      organizationId: org.id,
      userId: user.id,
    });

    expect(resolved.env).toEqual({});
    expect(resolved.missing).toEqual([
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        label: "Claude Code OAuth token",
        description: "Run `claude setup-token` and paste the result",
      },
    ]);
    expect(resolved.misconfigured).toEqual([]);
  });

  test("once deposited, the user's own value is injected", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat-user",
    });

    const resolved = await resolveRunnerCredentials({
      agent: agentWith([CLAUDE_TOKEN]),
      organizationId: org.id,
      userId: user.id,
    });

    expect(resolved.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-user",
    });
    expect(resolved.missing).toEqual([]);
  });

  test("each user resolves to their own value for the same declaration", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const first = await makeUser();
    const second = await makeUser();
    await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: first.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "first-token",
    });
    await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: second.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "second-token",
    });

    const agent = agentWith([CLAUDE_TOKEN]);
    const forFirst = await resolveRunnerCredentials({
      agent,
      organizationId: org.id,
      userId: first.id,
    });
    const forSecond = await resolveRunnerCredentials({
      agent,
      organizationId: org.id,
      userId: second.id,
    });

    expect(forFirst.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("first-token");
    expect(forSecond.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("second-token");
  });

  test("shared credentials come from the agent's bag, not the user", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const bag = await secretManager().createSecret(
      { SHARED_API_KEY: "org-wide-value" },
      "agent-runner-shared",
    );

    const resolved = await resolveRunnerCredentials({
      agent: agentWith([SHARED_API_KEY], bag.id),
      organizationId: org.id,
      userId: user.id,
    });

    expect(resolved.env).toEqual({ SHARED_API_KEY: "org-wide-value" });
    expect(resolved.missing).toEqual([]);
  });

  test("a missing shared credential is an admin problem, not a user prompt", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const resolved = await resolveRunnerCredentials({
      agent: agentWith([SHARED_API_KEY], null),
      organizationId: org.id,
      userId: user.id,
    });

    // Reported separately so the caller never asks a user to supply something
    // only an administrator can set.
    expect(resolved.missing).toEqual([]);
    expect(resolved.misconfigured.map((entry) => entry.key)).toEqual([
      "SHARED_API_KEY",
    ]);
  });

  test("optional credentials are omitted rather than reported missing", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const resolved = await resolveRunnerCredentials({
      agent: agentWith([{ ...CLAUDE_TOKEN, required: false }]),
      organizationId: org.id,
      userId: user.id,
    });

    expect(resolved.env).toEqual({});
    expect(resolved.missing).toEqual([]);
  });

  test("shared and personal credentials resolve together", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const bag = await secretManager().createSecret(
      { SHARED_API_KEY: "org-wide-value" },
      "agent-runner-shared",
    );
    await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "personal",
    });

    const resolved = await resolveRunnerCredentials({
      agent: agentWith([SHARED_API_KEY, CLAUDE_TOKEN], bag.id),
      organizationId: org.id,
      userId: user.id,
    });

    expect(resolved.env).toEqual({
      SHARED_API_KEY: "org-wide-value",
      CLAUDE_CODE_OAUTH_TOKEN: "personal",
    });
  });
});

describe("preflightRunnerCredentials", () => {
  test("reports the same missing personal credential without reading secrets", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const preflight = await preflightRunnerCredentials({
      agent: agentWith([CLAUDE_TOKEN]),
      organizationId: org.id,
      userId: user.id,
    });

    expect(preflight.missing.map((entry) => entry.key)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  test("reports nothing missing once the user has supplied it", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "token",
    });

    const preflight = await preflightRunnerCredentials({
      agent: agentWith([CLAUDE_TOKEN]),
      organizationId: org.id,
      userId: user.id,
    });

    expect(preflight.missing).toEqual([]);
    expect(preflight.misconfigured).toEqual([]);
  });
});

describe("sanitizeRunnerConfigForWriter", () => {
  test("an ordinary member cannot configure a privileged runner", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);

    // A privileged pod holds host devices and full capabilities, so granting
    // it is node-level access rather than an agent setting.
    await expect(
      sanitizeRunnerConfigForWriter({
        runnerConfig: { privileged: true },
        userId: user.id,
        organizationId: org.id,
      }),
    ).rejects.toThrow(/runner administrator/i);
  });

  test("a config without the flag passes through untouched", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const runnerConfig = { privileged: false, image: "example/image:1" };

    expect(
      await sanitizeRunnerConfigForWriter({
        runnerConfig,
        userId: user.id,
        organizationId: org.id,
      }),
    ).toBe(runnerConfig);
  });

  test("an admin may configure one", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const runnerConfig = { privileged: true };

    expect(
      await sanitizeRunnerConfigForWriter({
        runnerConfig,
        userId: admin.id,
        organizationId: org.id,
      }),
    ).toBe(runnerConfig);
  });
});
