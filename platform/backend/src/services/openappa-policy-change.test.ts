import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import {
  GithubAppConfigModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { secretManager } from "@/secrets-manager";
import { createGitlabToken } from "@/services/git-credentials";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { syncAppaGithubPolicy } from "@/services/openappa-github-sync";
import { getOpenAppaPolicyTests } from "@/services/openappa-policy-tests";
import { expect, test } from "@/test";
import { FakeGitlab } from "@/test/fake-gitlab";
import { useMswServer } from "@/test/msw";
import { ApiError } from "@/types";
import { PublicationUncertainError } from "@/types/openappa-publication";
import {
  findPublicationByKey,
  getOpenAppaPolicyChangeStatus,
  publishOpenAppaPolicyChange,
} from "./openappa-policy-change";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture
const server = useMswServer();
const baseSha = "a".repeat(40);
const fileSha = "b".repeat(40);
const changed = `${initialPolicy()}\n# Reviewable policy change\n`;

test("a locally managed policy refuses validation changes outside the validation workflow", async ({
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
      ...(scenario === "combined"
        ? { edits: [{ oldText: initialPolicy(), newText: changed }] }
        : { content: testsOnly ? initialPolicy() : changed }),
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
      // The commit names who asked in its message; it sets no author, which
      // would leave it unsigned.
      expect(commitWrites).toEqual([
        {
          message: `${params.title}\n\nRequested-by: ${user.email}`,
          tree: newTreeSha,
          parents: [baseSha],
        },
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
            message: string;
            author?: unknown;
          };
          expect(body.branch).toBe(head);
          expect(body.sha).toBe(fileSha);
          expect(Buffer.from(body.content, "base64").toString()).toBe(changed);
          // Who asked is in the message on this path too, and no author is set.
          expect(body.message).toMatch(
            new RegExp(`\\n\\nRequested-by: ${user.email}$`),
          );
          expect(body.author).toBeUndefined();
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

test("a merged policy PR that Git sync has not applied queues a sync; a failed sync since the merge, and then the applied merge, are what the status says", async ({
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
  });
  const merge = "c".repeat(40);
  server.use(
    http.get("https://api.github.com/repos/example/policies/pulls/17", () =>
      HttpResponse.json({
        number: 17,
        html_url: "https://github.com/example/policies/pull/17",
        state: "closed",
        merged: true,
        merged_at: "2026-11-13T18:03:39Z",
        merge_commit_sha: merge,
        mergeable: null,
        head: { ref: "archestra/openappa-change" },
      }),
    ),
    // The commit accepted before the merge lies behind it; any later one
    // holds it.
    http.get(
      ({ request }) =>
        request.url.startsWith(
          "https://api.github.com/repos/example/policies/compare/",
        ),
      ({ request }) => {
        const [base, head] = new URL(request.url).pathname
          .slice("/repos/example/policies/compare/".length)
          .split("...");
        expect(base).toBe(merge);
        return HttpResponse.json({
          status: head === baseSha ? "behind" : "ahead",
        });
      },
    ),
  );
  const status = () =>
    getOpenAppaPolicyChangeStatus({
      organizationId: org.id,
      userId: user.id,
      number: 17,
    });
  const queued = async () =>
    (await db.select().from(schema.tasksTable)).filter(
      (task) =>
        task.taskType === "openappa_github_sync" &&
        (task.payload as { organizationId?: string }).organizationId === org.id,
    );

  // Merged, and the accepted commit is still the one before the merge: a
  // pull is queued rather than left to the schedule.
  expect(await status()).toMatchObject({
    state: "merged",
    applied: false,
    syncQueued: true,
  });
  expect(await queued()).toHaveLength(1);
  // Asked again before it ran: still one pull queued.
  await status();
  expect(await queued()).toHaveLength(1);

  // A pull since the merge failed: that failure is the answer.
  const source = await OpenAppaGithubSyncModel.find(org.id);
  if (!source) throw new Error("Expected the source");
  await OpenAppaGithubSyncModel.finish({
    organizationId: org.id,
    revision: source.revision,
    outcome: { error: "GitHub returned HTTP 502" },
  });
  expect(await status()).toMatchObject({
    applied: false,
    syncFailed: { reason: "GitHub returned HTTP 502" },
  });

  // Pulled since: the accepted commit holds the merge.
  const failed = await OpenAppaGithubSyncModel.find(org.id);
  if (!failed) throw new Error("Expected the source");
  await OpenAppaGithubSyncModel.finish({
    organizationId: org.id,
    revision: failed.revision,
    outcome: {
      content: changed,
      contentHash: createHash("sha256").update(changed).digest("hex"),
      sourceCommit: "d".repeat(40),
    },
  });
  const applied = await status();
  expect(applied).toMatchObject({ state: "merged", applied: true });
  expect(applied).not.toHaveProperty("syncQueued");
});

test("a keyed GitHub publish asked again returns its pull request instead of opening a second, and the key finds it", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const { org, user, github } = await keyedGithubSetup({
    makeOrganization,
    makeUser,
    makeMember,
  });
  const publish = () =>
    publishOpenAppaPolicyChange(changeRequest(org.id, user.id, "fix-1:v1:a"));

  const first = await publish();
  const second = await publish();

  expect(second).toEqual(first);
  expect(github.writes).toEqual({ refs: 1, contents: 1, pulls: 1 });
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-1:v1:a",
    }),
  ).toEqual({
    delivery: "pull_request",
    number: 1,
    url: "https://github.com/example/policies/pull/1",
    state: "open",
  });
  github.pulls[0].merged_at = "2026-11-17T10:00:00Z";
  github.pulls[0].state = "closed";
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-1:v1:a",
    }),
  ).toMatchObject({ state: "merged" });
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-1:v1:b",
      repo: "example/policies",
    }),
  ).toBeNull();
  // A source moved to another repository cannot say the request is absent.
  await expect(
    findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-1:v1:b",
      repo: "example/old-policies",
    }),
  ).rejects.toThrow("Git source changed");
});

test("a keyed GitHub branch left without its commit or its pull request is completed, not duplicated", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const { org, user, github } = await keyedGithubSetup({
    makeOrganization,
    makeUser,
    makeMember,
  });
  const request = changeRequest(org.id, user.id, "fix-2:v1:a");

  // The branch is created, then the commit onto it fails.
  github.fail.contents = true;
  await expect(publishOpenAppaPolicyChange(request)).rejects.toThrow();
  // The commit lands, then GitHub refuses the pull request.
  github.fail.pulls = "refuse";
  const refused = await publishOpenAppaPolicyChange(request).catch((e) => e);
  expect(refused).toBeInstanceOf(ApiError);
  expect(refused).not.toBeInstanceOf(PublicationUncertainError);

  const done = await publishOpenAppaPolicyChange(request);

  expect(done).toMatchObject({ delivery: "pull_request", number: 1 });
  // One branch and one commit, each completed rather than made again.
  expect(github.writes).toEqual({ refs: 1, contents: 2, pulls: 2 });
  expect(github.pulls).toHaveLength(1);
});

test("a keyed GitHub pull request create without an answer is uncertain until the branch's request decides it", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const { org, user, github } = await keyedGithubSetup({
    makeOrganization,
    makeUser,
    makeMember,
  });
  const request = changeRequest(org.id, user.id, "fix-3:v1:a");

  github.fail.pulls = "unanswered";
  const unanswered = await publishOpenAppaPolicyChange(request).catch((e) => e);
  expect(unanswered).toBeInstanceOf(PublicationUncertainError);
  expect(unanswered.operationKey).toBe("fix-3:v1:a");
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-3:v1:a",
    }),
  ).toBeNull();

  // A server fault after GitHub opened the request: the request is the answer.
  github.fail.pulls = "fault-after-create";
  expect(await publishOpenAppaPolicyChange(request)).toMatchObject({
    number: 1,
  });
  expect(github.writes).toEqual({ refs: 1, contents: 1, pulls: 2 });
  expect(github.pulls).toHaveLength(1);
});

test("concurrent keyed GitHub publishes under one key converge on one branch and one pull request", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const { org, user, github } = await keyedGithubSetup({
    makeOrganization,
    makeUser,
    makeMember,
  });
  const request = changeRequest(org.id, user.id, "fix-8:v1:a");
  // Both look for the pull request, then for the branch, before either acts.
  const lookups = rendezvous(2);
  const branchReads = rendezvous(2);
  server.use(
    http.get("https://api.github.com/repos/example/policies/pulls", () =>
      lookups(),
    ),
    http.get(
      ({ request }) =>
        new URL(request.url).pathname.startsWith(
          "/repos/example/policies/branches/archestra%2Fopenappa-op-",
        ),
      () => branchReads(),
    ),
  );

  const [first, second] = await Promise.all([
    publishOpenAppaPolicyChange(request),
    publishOpenAppaPolicyChange(request),
  ]);

  expect(second).toEqual(first);
  expect(github.pulls).toHaveLength(1);
  expect(github.commits.size).toBe(1);
  // Both raced for the branch and the pull request; one lost each.
  expect(github.writes).toMatchObject({ refs: 2, pulls: 2 });
});

test("a keyed GitHub branch that holds another change is refused", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const { org, user, github } = await keyedGithubSetup({
    makeOrganization,
    makeUser,
    makeMember,
  });
  github.fail.pulls = "refuse";
  await expect(
    publishOpenAppaPolicyChange(changeRequest(org.id, user.id, "fix-4:v1:a")),
  ).rejects.toThrow();

  await expect(
    publishOpenAppaPolicyChange({
      ...changeRequest(org.id, user.id, "fix-4:v1:a"),
      content: `${changed}# Something else\n`,
    }),
  ).rejects.toThrow("already holds a different change");
  // The intended policy, and a file nobody asked for, in one commit.
  const [left] = [...github.commits.values()];
  left.extraFile = true;
  await expect(
    publishOpenAppaPolicyChange(changeRequest(org.id, user.id, "fix-4:v1:a")),
  ).rejects.toThrow("already holds a different change");
  expect(github.writes.pulls).toBe(1);
  expect(github.pulls).toHaveLength(0);
});

test("without a key every publish opens its own branch and a server fault stays an ordinary failure", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const { org, user, github } = await keyedGithubSetup({
    makeOrganization,
    makeUser,
    makeMember,
  });
  const { operationKey: _, ...request } = changeRequest(org.id, user.id, "-");

  await publishOpenAppaPolicyChange(request);
  github.fail.pulls = "fault-after-create";
  const fault = await publishOpenAppaPolicyChange(request).catch((e) => e);

  expect(fault).toBeInstanceOf(ApiError);
  expect(fault).not.toBeInstanceOf(PublicationUncertainError);
  expect(github.writes).toEqual({ refs: 2, contents: 2, pulls: 2 });
  expect(new Set(github.pulls.map((pull) => pull.head)).size).toBe(2);
});

test("a keyed GitLab publish asked again returns its merge request, and the key finds it", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const gitlab = await configureGitlabSource(org.id);
  const request = changeRequest(org.id, user.id, "fix-5:v1:a");

  const first = await publishOpenAppaPolicyChange(request);
  const second = await publishOpenAppaPolicyChange(request);

  expect(first).toMatchObject({ delivery: "pull_request", number: 1 });
  expect(second).toMatchObject({ delivery: "pull_request", number: 1 });
  expect(gitlab.projects.get(GITLAB_REPO)?.mergeRequests).toHaveLength(1);
  expect(commitPosts(gitlab)).toBe(1);
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-5:v1:a",
    }),
  ).toEqual({
    delivery: "pull_request",
    number: 1,
    url: `${GITLAB}/${GITLAB_REPO}/-/merge_requests/1`,
    state: "open",
  });
  gitlab.merge(GITLAB_REPO, 1);
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-5:v1:a",
    }),
  ).toMatchObject({ state: "merged" });
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-5:v1:b",
    }),
  ).toBeNull();
});

test("a keyed GitLab merge request create without an answer is uncertain, and a retry completes the branch it left", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const gitlab = await configureGitlabSource(org.id);
  const request = changeRequest(org.id, user.id, "fix-6:v1:a");
  server.use(
    http.post(
      `${GITLAB}/api/v4/projects/${encodeURIComponent(GITLAB_REPO)}/merge_requests`,
      () => HttpResponse.error(),
      { once: true },
    ),
  );

  const unanswered = await publishOpenAppaPolicyChange(request).catch((e) => e);
  expect(unanswered).toBeInstanceOf(PublicationUncertainError);
  expect(
    await findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-6:v1:a",
    }),
  ).toBeNull();
  await expect(
    publishOpenAppaPolicyChange({
      ...request,
      content: `${changed}# Something else\n`,
    }),
  ).rejects.toThrow("already holds a different change");
  // The intended policy, and a file nobody asked for, in one commit.
  const keyedBranch = [
    ...(gitlab.projects.get(GITLAB_REPO)?.branches.keys() ?? []),
  ].find((name) => name.startsWith("archestra/openappa-op-"));
  if (!keyedBranch) throw new Error("Expected the keyed branch");
  const left = gitlab.branchHead(GITLAB_REPO, keyedBranch);
  gitlab.setBranch(
    GITLAB_REPO,
    "crafted",
    gitlab.branchHead(GITLAB_REPO, "main"),
  );
  gitlab.setBranch(
    GITLAB_REPO,
    keyedBranch,
    gitlab.commit(GITLAB_REPO, "crafted", {
      "appa.toml": changed,
      "other.toml": "# unrequested\n",
    }),
  );
  await expect(publishOpenAppaPolicyChange(request)).rejects.toThrow(
    "already holds a different change",
  );
  gitlab.setBranch(GITLAB_REPO, keyedBranch, left);

  expect(await publishOpenAppaPolicyChange(request)).toMatchObject({
    number: 1,
  });
  expect(commitPosts(gitlab)).toBe(1);
  expect(gitlab.projects.get(GITLAB_REPO)?.mergeRequests).toHaveLength(1);
});

test("concurrent keyed GitLab publishes under one key converge on one merge request", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const gitlab = await configureGitlabSource(org.id);
  const request = changeRequest(org.id, user.id, "fix-9:v1:a");
  // Both look for the merge request, then for the branch, before either acts.
  const lookups = rendezvous(2);
  const branchReads = rendezvous(2);
  const project = `/api/v4/projects/${encodeURIComponent(GITLAB_REPO)}`;
  server.use(
    http.get(
      ({ request }) =>
        new URL(request.url).pathname === `${project}/merge_requests`,
      () => lookups(),
    ),
    http.get(
      ({ request }) =>
        new URL(request.url).pathname.startsWith(
          `${project}/repository/branches/archestra%2Fopenappa-op-`,
        ),
      () => branchReads(),
    ),
  );

  const [first, second] = await Promise.all([
    publishOpenAppaPolicyChange(request),
    publishOpenAppaPolicyChange(request),
  ]);

  expect(second).toEqual(first);
  expect(gitlab.projects.get(GITLAB_REPO)?.mergeRequests).toHaveLength(1);
  // Both raced for the branch; one lost.
  expect(commitPosts(gitlab)).toBe(2);
});

test("the key finds a locally saved revision by the content it was to hold", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const contentHash = createHash("sha256").update(changed).digest("hex");
  const find = (local: { expectedRevision: number; contentHash: string }) =>
    findPublicationByKey({
      organizationId: org.id,
      operationKey: "fix-7:v1:a",
      local,
    });
  expect(await find({ expectedRevision: 0, contentHash })).toBeNull();

  await publishOpenAppaPolicyChange({
    ...changeRequest(org.id, user.id, "fix-7:v1:a"),
    expectedRevision: 0,
  });

  expect(await find({ expectedRevision: 0, contentHash })).toEqual({
    delivery: "revision",
    revision: 1,
  });
  expect(
    await find({ expectedRevision: 0, contentHash: "0".repeat(64) }),
  ).toBeNull();
  expect(await find({ expectedRevision: 1, contentHash })).toBeNull();
});

const GITLAB = "https://gitlab.example.test";
const GITLAB_REPO = "team/policies";

function changeRequest(
  organizationId: string,
  userId: string,
  operationKey: string,
) {
  return {
    organizationId,
    userId,
    content: changed,
    expectedRevision: 1,
    title: "Tighten the policy",
    summary: "Adds a comment.",
    operationKey,
  };
}

/**
 * A request handler that answers nothing, so the request falls through to the
 * fake, but holds the first `count` requests until all have arrived: racing
 * publishes then read the same state before either writes.
 */
function rendezvous(count: number) {
  let arrived = 0;
  let release = () => {};
  const met = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await met;
  };
}

function commitPosts(gitlab: FakeGitlab) {
  return gitlab.requests.filter(
    (request) =>
      request.method === "POST" && request.path.endsWith("/repository/commits"),
  ).length;
}

async function configureGitlabSource(organizationId: string) {
  config.openappa.enabled = true;
  const gitlab = new FakeGitlab(GITLAB, "glpat-test-token");
  server.use(...gitlab.handlers());
  gitlab.addProject({
    path: GITLAB_REPO,
    files: { "appa.toml": initialPolicy() },
  });
  const gitlabTokenId = (
    await createGitlabToken({
      organizationId,
      data: { name: "GitLab", gitlabUrl: GITLAB, token: "glpat-test-token" },
    })
  ).id;
  await OpenAppaGithubSyncModel.save(organizationId, {
    repo: GITLAB_REPO,
    ref: null,
    path: "appa.toml",
    interval: "1h",
    githubPatId: null,
    githubAppConfigId: null,
    gitlabTokenId,
  });
  await syncAppaGithubPolicy(organizationId);
  expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(1);
  return gitlab;
}

/**
 * A GitHub repository that keeps its branches, the commits the contents API
 * makes and the pull requests opened, so a publish asked twice meets what the
 * first one left. `fail` makes the next contents write or pull request create
 * fail once.
 */
async function keyedGithubSetup(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    options: { role: string },
  ) => Promise<unknown>;
}) {
  config.openappa.enabled = true;
  const org = await fixtures.makeOrganization();
  const user = await fixtures.makeUser();
  await fixtures.makeMember(user.id, org.id, { role: "admin" });
  await configureValidationSource({
    organizationId: org.id,
    directory: "traces",
    appWriter: true,
    patUserId: user.id,
  });
  const repo = "https://api.github.com/repos/example/policies";
  const branches = new Map([["main", baseSha]]);
  const commits = new Map<
    string,
    { parent: string; blob: string; extraFile?: boolean }
  >();
  const github = {
    branches,
    commits,
    writes: { refs: 0, contents: 0, pulls: 0 },
    pulls: [] as {
      number: number;
      head: string;
      state: "open" | "closed";
      merged_at: string | null;
    }[],
    fail: {} as {
      contents?: boolean;
      pulls?: "refuse" | "unanswered" | "fault-after-create";
    },
  };
  const openPull = (head: string) => {
    const pull = {
      number: github.pulls.length + 1,
      head,
      state: "open" as const,
      merged_at: null,
    };
    github.pulls.push(pull);
    return pull;
  };
  server.use(
    http.get(
      ({ request }) =>
        new URL(request.url).pathname.startsWith(
          "/repos/example/policies/branches/",
        ),
      ({ request }) => {
        const name = decodeURIComponent(
          new URL(request.url).pathname.slice(
            "/repos/example/policies/branches/".length,
          ),
        );
        const sha = branches.get(name);
        return sha
          ? HttpResponse.json({ commit: { sha } })
          : HttpResponse.json({ message: "Branch not found" }, { status: 404 });
      },
    ),
    http.get(`${repo}/contents/appa.toml`, ({ request }) => {
      const ref = new URL(request.url).searchParams.get("ref") ?? "";
      const blob = ref === baseSha ? fileSha : commits.get(ref)?.blob;
      return blob
        ? HttpResponse.json({ sha: blob })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.get(`${repo}/compare/:range`, ({ params }) => {
      const [from, to] = String(params.range).split("...");
      const commit = commits.get(to);
      if (from !== baseSha || !commit || commit.parent !== baseSha)
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      return HttpResponse.json({
        files: [
          { filename: "appa.toml", status: "modified", sha: commit.blob },
          ...(commit.extraFile
            ? [{ filename: "other.toml", status: "added", sha: fileSha }]
            : []),
        ],
      });
    }),
    http.get(`${repo}/git/commits/:sha`, ({ params }) => {
      const commit = commits.get(String(params.sha));
      return commit
        ? HttpResponse.json({
            sha: params.sha,
            tree: { sha: "e".repeat(40) },
            parents: [{ sha: commit.parent }],
          })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.post(`${repo}/git/refs`, async ({ request }) => {
      github.writes.refs += 1;
      const body = (await request.json()) as { ref: string; sha: string };
      const name = body.ref.replace("refs/heads/", "");
      if (branches.has(name))
        return HttpResponse.json(
          { message: "Reference already exists" },
          { status: 422 },
        );
      branches.set(name, body.sha);
      return HttpResponse.json({ ref: body.ref }, { status: 201 });
    }),
    http.put(`${repo}/contents/appa.toml`, async ({ request }) => {
      github.writes.contents += 1;
      if (github.fail.contents) {
        github.fail.contents = false;
        return HttpResponse.json({ message: "Server Error" }, { status: 500 });
      }
      const body = (await request.json()) as {
        branch: string;
        content: string;
        sha: string;
      };
      const parent = branches.get(body.branch);
      if (!parent)
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      // Like GitHub, a write must name the file it replaces.
      const current = parent === baseSha ? fileSha : commits.get(parent)?.blob;
      if (body.sha !== current)
        return HttpResponse.json(
          { message: "appa.toml does not match" },
          { status: 409 },
        );
      const content = Buffer.from(body.content, "base64");
      const blob = createHash("sha1")
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex");
      const sha = createHash("sha1").update(`${parent}${blob}`).digest("hex");
      commits.set(sha, { parent, blob });
      branches.set(body.branch, sha);
      return HttpResponse.json({ commit: { sha } }, { status: 201 });
    }),
    http.post(`${repo}/pulls`, async ({ request }) => {
      github.writes.pulls += 1;
      const body = (await request.json()) as { head: string };
      const fail = github.fail.pulls;
      github.fail.pulls = undefined;
      if (fail === "refuse")
        return HttpResponse.json({ message: "Forbidden" }, { status: 403 });
      if (fail === "unanswered") return HttpResponse.error();
      if (
        github.pulls.some(
          (pull) => pull.head === body.head && pull.state === "open",
        )
      )
        return HttpResponse.json(
          { message: "A pull request already exists" },
          { status: 422 },
        );
      const pull = openPull(body.head);
      if (fail === "fault-after-create")
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      return HttpResponse.json(
        {
          number: pull.number,
          html_url: `https://github.com/example/policies/pull/${pull.number}`,
        },
        { status: 201 },
      );
    }),
    http.get(`${repo}/pulls`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("state")).toBe("all");
      const head = url.searchParams.get("head");
      return HttpResponse.json(
        github.pulls
          .filter((pull) => `example:${pull.head}` === head)
          .map((pull) => ({
            number: pull.number,
            html_url: `https://github.com/example/policies/pull/${pull.number}`,
            state: pull.state,
            merged_at: pull.merged_at,
            head: { ref: pull.head },
          })),
      );
    }),
  );
  return { org, user, github };
}
