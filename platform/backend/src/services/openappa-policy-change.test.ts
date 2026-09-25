import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { GithubAppConfigModel } from "@/models";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { secretManager } from "@/secrets-manager";
import { initialPolicy } from "@/services/guardrails-policy";
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

test("GitHub sync creates a policy PR with the configured App and reports its status", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const installationId = randomUUID();
  const secret = await secretManager().createSecret(
    { apiToken: privateKey },
    "test-policy-app",
  );
  const app = await GithubAppConfigModel.create({
    organizationId: org.id,
    name: "Policy App",
    githubUrl: "https://api.github.com",
    appId: "123",
    installationId,
    secretId: secret.id,
  });
  await OpenAppaGithubSyncModel.save(org.id, {
    repo: "example/policies",
    ref: "main",
    path: "guardrails/appa.toml",
    interval: "1h",
    githubAppConfigId: app.id,
    githubPatId: null,
  });
  const source = await OpenAppaGithubSyncModel.find(org.id);
  if (!source) throw new Error("Expected GitHub sync source");
  await OpenAppaGithubSyncModel.finish({
    organizationId: org.id,
    revision: source.revision,
    outcome: {
      content: initialPolicy(),
      contentHash: createHash("sha256").update(initialPolicy()).digest("hex"),
      sourceCommit: baseSha,
    },
  });
  let head = "";
  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () =>
        HttpResponse.json({
          token: "test-installation-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
    ),
    http.get(
      "https://api.github.com/repos/example/policies/branches/main",
      () => HttpResponse.json({ commit: { sha: baseSha } }),
    ),
    http.get(
      "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
      ({ request }) => {
        expect(new URL(request.url).searchParams.get("ref")).toBe(baseSha);
        return HttpResponse.json({ sha: fileSha });
      },
    ),
    http.post(
      "https://api.github.com/repos/example/policies/git/refs",
      async ({ request }) => {
        const body = (await request.json()) as { ref: string; sha: string };
        expect(body.sha).toBe(baseSha);
        head = body.ref.replace("refs/heads/", "");
        expect(head).toMatch(/^archestra\/openappa-/);
        return HttpResponse.json({ ref: body.ref }, { status: 201 });
      },
    ),
    http.put(
      "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
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
    http.get("https://api.github.com/repos/example/policies/pulls/17", () =>
      HttpResponse.json({
        number: 17,
        html_url: "https://github.com/example/policies/pull/17",
        state: "open",
        merged: false,
        mergeable: true,
        head: { ref: head },
      }),
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
