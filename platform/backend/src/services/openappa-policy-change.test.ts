import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  GithubAppConfigModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { secretManager } from "@/secrets-manager";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { getOpenAppaPolicyTests } from "@/services/openappa-policy-tests";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  getOpenAppaPolicyChangeStatus,
  publishOpenAppaPolicyChange,
} from "./openappa-policy-change";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture
const server = useMswServer();
const baseSha = "a".repeat(40);
const fileSha = "b".repeat(40);
const changed = `${initialPolicy()}\n# Reviewable policy change\n`;

test("a locally managed change validates and saves a new revision", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });

  await expect(
    publishOpenAppaPolicyChange({
      organizationId: org.id,
      userId: user.id,
      content: changed,
      expectedRevision: 0,
      title: "Clarify policy with validation",
      summary: "Keep the change together",
      validationChanges: {
        upsert: [
          { path: "traces/new.appa", content: "# Essential scenario\n" },
        ],
        delete: [],
        directory: "traces",
        expectedVersion: "empty",
      },
    }),
  ).rejects.toThrow("Save local policy and validation changes together");
  expect((await guardrailsPolicyService.get(org.id)).revision).toBe(0);

  const result = await publishOpenAppaPolicyChange({
    organizationId: org.id,
    userId: user.id,
    content: changed,
    expectedRevision: 0,
    title: "Clarify policy",
    summary: "Explain the change",
  });

  expect(result).toMatchObject({
    delivery: "revision",
    revision: 1,
    before: initialPolicy(),
    after: changed,
  });
});

for (const scenario of [
  "combined",
  "tests-only",
  "pat-tests-only",
  "pat-write-denied",
  "stale-version",
  "unsafe-path",
  "symlink",
  "source-race",
  "directory-race",
  "disabled-directory",
  "missing-writer",
  "tree-failure",
  "branch-race",
] as const) {
  test(`validation PR ${scenario} preserves the accepted source and commits changes together`, async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    config.openappa.enabled = true;
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    await configureValidationSource({
      organizationId: org.id,
      directory: scenario === "disabled-directory" ? "" : "traces",
      appWriter: scenario !== "missing-writer",
      patUserId: scenario.startsWith("pat-") ? user.id : undefined,
    });
    const treeSha = "c".repeat(40);
    const directorySha = "d".repeat(40);
    const newTreeSha = "e".repeat(40);
    const newCommitSha = "f".repeat(40);
    const treeWrites: unknown[] = [];
    const commitWrites: unknown[] = [];
    const refWrites: unknown[] = [];
    const pullWrites: unknown[] = [];
    let branchReads = 0;
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/branches/main",
        () => {
          branchReads += 1;
          return HttpResponse.json({
            commit: {
              sha:
                scenario === "branch-race" && branchReads > 1
                  ? fileSha
                  : baseSha,
            },
          });
        },
      ),
      http.get(
        `https://api.github.com/repos/example/policies/git/commits/${baseSha}`,
        () => HttpResponse.json({ tree: { sha: treeSha } }),
      ),
      http.get(
        `https://api.github.com/repos/example/policies/git/trees/${treeSha}`,
        async () => {
          if (scenario === "source-race")
            await OpenAppaGithubSyncModel.setInterval(org.id, null);
          if (scenario === "directory-race") {
            const source = await OpenAppaGithubSyncModel.find(org.id);
            if (!source) throw new Error("Expected source");
            await OpenAppaGithubSyncModel.save(org.id, {
              repo: "example/policies",
              ref: source.ref,
              path: "appa.toml",
              interval: "1h",
              githubPatId: source.githubPatId,
              githubAppConfigId: source.githubAppConfigId,
              validationDirectory: "other-tests",
            });
          }
          return HttpResponse.json({
            truncated: false,
            tree: [
              { path: "appa.toml", mode: "100644", type: "blob", sha: fileSha },
              {
                path: "traces",
                mode: "040000",
                type: "tree",
                sha: directorySha,
              },
              { path: "README.md", mode: "100644", type: "blob", sha: fileSha },
            ],
          });
        },
      ),
      http.get(
        `https://api.github.com/repos/example/policies/git/trees/${directorySha}`,
        () =>
          HttpResponse.json({
            truncated: false,
            tree: [
              {
                path: "remove.appa",
                mode: "100644",
                type: "blob",
                sha: fileSha,
              },
              ...(scenario === "symlink"
                ? [
                    {
                      path: "new.appa",
                      mode: "120000",
                      type: "blob",
                      sha: fileSha,
                    },
                  ]
                : []),
            ],
          }),
      ),
      http.post(
        "https://api.github.com/repos/example/policies/git/trees",
        async ({ request }) => {
          if (scenario.startsWith("pat-"))
            expect(request.headers.get("authorization")).toBe(
              "Bearer test-policy-pat",
            );
          treeWrites.push(await request.json());
          return scenario === "tree-failure" || scenario === "pat-write-denied"
            ? HttpResponse.json(
                { message: "not persisted or echoed" },
                { status: scenario === "pat-write-denied" ? 403 : 422 },
              )
            : HttpResponse.json({ sha: newTreeSha });
        },
      ),
      http.post(
        "https://api.github.com/repos/example/policies/git/commits",
        async ({ request }) => {
          commitWrites.push(await request.json());
          return HttpResponse.json({ sha: newCommitSha });
        },
      ),
      http.post(
        "https://api.github.com/repos/example/policies/git/refs",
        async ({ request }) => {
          refWrites.push(await request.json());
          return HttpResponse.json({ ref: "created" });
        },
      ),
      http.post(
        "https://api.github.com/repos/example/policies/pulls",
        async ({ request }) => {
          pullWrites.push(await request.json());
          return HttpResponse.json({
            number: 18,
            html_url: "https://github.com/example/policies/pull/18",
          });
        },
      ),
    );
    const collection = await getOpenAppaPolicyTests(org.id, user.id);
    const testsOnly = scenario === "tests-only" || scenario.startsWith("pat-");
    const params = {
      organizationId: org.id,
      userId: user.id,
      content: testsOnly ? initialPolicy() : changed,
      includePolicy: !testsOnly,
      expectedRevision: 1,
      title: "Add policy regression validation",
      summary: "Cover the intended boundary",
      validationChanges: {
        upsert: [
          {
            path:
              scenario === "unsafe-path"
                ? "traces/../outside.appa"
                : "traces/new.appa",
            content: "# Essential guardrail scenario\n",
          },
        ],
        delete: ["traces/remove.appa"],
        directory: "traces",
        expectedVersion:
          scenario === "stale-version" ? "outdated" : collection.version,
      },
    };
    if (
      scenario !== "combined" &&
      scenario !== "tests-only" &&
      scenario !== "pat-tests-only"
    ) {
      await expect(publishOpenAppaPolicyChange(params)).rejects.toThrow();
      expect(refWrites).toEqual([]);
      expect(pullWrites).toEqual([]);
      if (scenario !== "tree-failure" && scenario !== "pat-write-denied")
        expect(treeWrites).toEqual([]);
      expect(commitWrites).toEqual([]);
    } else {
      const result = await publishOpenAppaPolicyChange(params);
      expect(result.delivery).toBe("pull_request");
      expect(treeWrites).toEqual([
        {
          base_tree: treeSha,
          tree: [
            {
              path: "traces/new.appa",
              mode: "100644",
              type: "blob",
              content: "# Essential guardrail scenario\n",
            },
            {
              path: "traces/remove.appa",
              mode: "100644",
              type: "blob",
              sha: null,
            },
            ...(scenario === "combined"
              ? [
                  {
                    path: "appa.toml",
                    mode: "100644",
                    type: "blob",
                    content: changed,
                  },
                ]
              : []),
          ],
        },
      ]);
      expect(commitWrites).toEqual([
        { message: params.title, tree: newTreeSha, parents: [baseSha] },
      ]);
      expect(refWrites).toEqual([
        {
          ref: expect.stringMatching(/^refs\/heads\/archestra\/openappa-/),
          sha: newCommitSha,
        },
      ]);
      expect(pullWrites).toEqual([
        {
          title: params.title,
          body: params.summary,
          head: expect.stringMatching(/^archestra\/openappa-/),
          base: "main",
        },
      ]);
    }
    const active = await guardrailsPolicyService.get(org.id);
    expect(active).toMatchObject({ content: initialPolicy(), revision: 1 });
  });
}

async function configureValidationSource(params: {
  organizationId: string;
  directory: string;
  appWriter: boolean;
  patUserId?: string;
}) {
  const { organizationId } = params;
  const installationId = randomUUID();
  let githubAppConfigId: string | null = null;
  let githubPatId: string | null = null;
  if (params.patUserId) {
    const pat = await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: params.patUserId,
      definition: {
        key: "policy-pat",
        name: "Policy token",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: pat.key,
      value: "test-policy-pat",
    });
    githubPatId = pat.id;
  } else {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-validation-app",
    );
    const app = await GithubAppConfigModel.create({
      organizationId,
      name: "Validation App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    githubAppConfigId = params.appWriter ? app.id : null;
  }
  await OpenAppaGithubSyncModel.save(organizationId, {
    repo: "example/policies",
    ref: "main",
    path: "appa.toml",
    interval: "1h",
    githubAppConfigId,
    githubPatId,
    validationDirectory: params.directory,
  });
  const source = await OpenAppaGithubSyncModel.find(organizationId);
  if (!source) throw new Error("Expected GitHub sync source");
  await OpenAppaGithubSyncModel.finish({
    organizationId,
    revision: source.revision,
    outcome: {
      content: initialPolicy(),
      contentHash: createHash("sha256").update(initialPolicy()).digest("hex"),
      sourceCommit: baseSha,
    },
  });
  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () =>
        HttpResponse.json({
          token: "test-validation-installation-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
    ),
    http.get(
      "https://api.github.com/repos/example/policies/contents/traces",
      () =>
        HttpResponse.json([
          { path: "traces/remove.appa", type: "file", size: 6 },
        ]),
    ),
    http.get(
      "https://api.github.com/repos/example/policies/contents/traces/remove.appa",
      ({ request }) => {
        expect(new URL(request.url).searchParams.get("ref")).toBe(baseSha);
        return HttpResponse.text("# Old\n");
      },
    ),
  );
}

for (const credential of ["app", "pat"] as const) {
  test(`GitHub sync creates a policy PR with the configured ${credential} and reports its status`, async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    config.openappa.enabled = true;
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    await configureValidationSource({
      organizationId: org.id,
      directory: "traces",
      appWriter: true,
      patUserId: credential === "pat" ? user.id : undefined,
    });
    let head = "";
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/branches/main",
        () => HttpResponse.json({ commit: { sha: baseSha } }),
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/appa.toml",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("ref")).toBe(baseSha);
          return HttpResponse.json({ sha: fileSha });
        },
      ),
      http.post(
        "https://api.github.com/repos/example/policies/git/refs",
        async ({ request }) => {
          if (credential === "pat")
            expect(request.headers.get("authorization")).toBe(
              "Bearer test-policy-pat",
            );
          const body = (await request.json()) as { ref: string; sha: string };
          expect(body.sha).toBe(baseSha);
          head = body.ref.replace("refs/heads/", "");
          expect(head).toMatch(/^archestra\/openappa-/);
          return HttpResponse.json({ ref: body.ref }, { status: 201 });
        },
      ),
      http.put(
        "https://api.github.com/repos/example/policies/contents/appa.toml",
        async ({ request }) => {
          const body = (await request.json()) as {
            branch: string;
            sha: string;
            content: string;
          };
          expect(body.branch).toBe(head);
          expect(body.sha).toBe(fileSha);
          expect(Buffer.from(body.content, "base64").toString()).toBe(changed);
          return HttpResponse.json({ content: { sha: fileSha } });
        },
      ),
      http.post(
        "https://api.github.com/repos/example/policies/pulls",
        async ({ request }) => {
          const body = (await request.json()) as {
            head: string;
            base: string;
          };
          expect(body).toMatchObject({ head, base: "main" });
          return HttpResponse.json(
            {
              number: 17,
              html_url: "https://github.com/example/policies/pull/17",
            },
            { status: 201 },
          );
        },
      ),
      http.get(
        "https://api.github.com/repos/example/policies/pulls/17",
        ({ request }) => {
          if (credential === "pat")
            expect(request.headers.get("authorization")).toBe(
              "Bearer test-policy-pat",
            );
          return HttpResponse.json({
            number: 17,
            html_url: "https://github.com/example/policies/pull/17",
            state: "open",
            merged: false,
            mergeable: true,
            head: { ref: head },
          });
        },
      ),
    );

    const result = await publishOpenAppaPolicyChange({
      organizationId: org.id,
      userId: user.id,
      content: changed,
      expectedRevision: 1,
      title: "Clarify policy",
      summary: "Explain the change",
    });
    expect(result).toMatchObject({
      delivery: "pull_request",
      number: 17,
      url: "https://github.com/example/policies/pull/17",
      before: initialPolicy(),
      after: changed,
    });
    expect(
      await getOpenAppaPolicyChangeStatus({
        organizationId: org.id,
        userId: user.id,
        number: 17,
      }),
    ).toMatchObject({ state: "open", mergeable: true });
  });
}
