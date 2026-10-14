import {
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { type GitHubUserId, GitHubUserIdSchema, type User } from "@/types";

const ALICE_GITHUB_ID = GitHubUserIdSchema.parse(1001);
const BOB_GITHUB_ID = GitHubUserIdSchema.parse(1002);

describe("RuntimeCredentialConnectionModel.listGitHubRoster", () => {
  let organizationId: string;
  let admin: User;

  beforeEach(async ({ makeAdmin, makeOrganization, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeAdmin();
    await makeMember(admin.id, organizationId, { role: "admin" });
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: admin.id,
      definition: {
        description: "",
        icon: null,
        key: "repository-app",
        name: "Repository App",
        kind: "github_app",
        allowPersonal: false,
        allowOrganization: true,
        githubUrl: "https://api.github.com",
        appId: "123",
        installationId: "456",
        githubClientId: "test-client",
      },
    });
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: admin.id,
      definition: {
        description: "",
        icon: null,
        key: "github-user",
        name: "GitHub",
        kind: "github_app_user",
        allowPersonal: true,
        allowOrganization: false,
        githubAppCredentialKey: "repository-app",
      },
    });
  });

  async function connect(userId: string, githubId?: GitHubUserId) {
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "personal",
      userId,
      credentialId: "github-user",
      value: "token",
      githubId,
    });
  }

  test("maps the connected GitHub id of a member to their email", async ({
    makeUser,
    makeMember,
  }) => {
    const alice = await makeUser({ email: "alice@example.com" });
    await makeMember(alice.id, organizationId);
    await connect(alice.id, ALICE_GITHUB_ID);

    expect(
      await RuntimeCredentialConnectionModel.listGitHubRoster(organizationId),
    ).toEqual(new Map([[ALICE_GITHUB_ID, "alice@example.com"]]));
  });

  test("excludes users who are no longer organization members", async ({
    makeUser,
  }) => {
    const outsider = await makeUser();
    await connect(outsider.id, ALICE_GITHUB_ID);

    expect(
      (await RuntimeCredentialConnectionModel.listGitHubRoster(organizationId))
        .size,
    ).toBe(0);
  });

  test("drops a GitHub id held by more than one member", async ({
    makeUser,
    makeMember,
  }) => {
    const alice = await makeUser();
    const mallory = await makeUser();
    const bob = await makeUser({ email: "bob@example.com" });
    for (const user of [alice, mallory, bob])
      await makeMember(user.id, organizationId);
    await connect(alice.id, ALICE_GITHUB_ID);
    await connect(mallory.id, ALICE_GITHUB_ID);
    await connect(bob.id, BOB_GITHUB_ID);

    expect(
      await RuntimeCredentialConnectionModel.listGitHubRoster(organizationId),
    ).toEqual(new Map([[BOB_GITHUB_ID, "bob@example.com"]]));
  });

  test("is empty once the GitHub App points away from GitHub.com", async ({
    makeUser,
    makeMember,
  }) => {
    const alice = await makeUser();
    await makeMember(alice.id, organizationId);
    await connect(alice.id, ALICE_GITHUB_ID);

    await RuntimeCredentialDefinitionModel.update({
      organizationId,
      key: "repository-app",
      definition: { githubUrl: "https://github.example.com/api/v3" },
    });

    expect(
      (await RuntimeCredentialConnectionModel.listGitHubRoster(organizationId))
        .size,
    ).toBe(0);
  });

  test("forgets a member after disconnect", async ({
    makeUser,
    makeMember,
  }) => {
    const alice = await makeUser();
    await makeMember(alice.id, organizationId);
    await connect(alice.id, ALICE_GITHUB_ID);

    await RuntimeCredentialConnectionModel.delete({
      organizationId,
      scope: "personal",
      userId: alice.id,
      credentialId: "github-user",
    });

    expect(
      (await RuntimeCredentialConnectionModel.listGitHubRoster(organizationId))
        .size,
    ).toBe(0);
  });

  test("forgets every member after the credential definition is deleted", async ({
    makeUser,
    makeMember,
  }) => {
    const alice = await makeUser();
    await makeMember(alice.id, organizationId);
    await connect(alice.id, ALICE_GITHUB_ID);

    await RuntimeCredentialConnectionModel.deleteForDefinition({
      organizationId,
      credentialId: "github-user",
    });

    expect(
      (await RuntimeCredentialConnectionModel.listGitHubRoster(organizationId))
        .size,
    ).toBe(0);
  });

  test("keeps the stored GitHub id when a refresh omits it", async ({
    makeUser,
    makeMember,
  }) => {
    const alice = await makeUser({ email: "alice@example.com" });
    await makeMember(alice.id, organizationId);
    await connect(alice.id, ALICE_GITHUB_ID);

    await connect(alice.id);

    expect(
      await RuntimeCredentialConnectionModel.listGitHubRoster(organizationId),
    ).toEqual(new Map([[ALICE_GITHUB_ID, "alice@example.com"]]));
  });
});
