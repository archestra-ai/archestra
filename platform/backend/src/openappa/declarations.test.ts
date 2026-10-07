import { generateKeyPairSync } from "node:crypto";
import { HttpResponse, http } from "msw";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { openappaDeclarations } from "@/openappa/declarations";
import { openappaFailure } from "@/openappa/failure";
import { expect, test } from "@/test";
import { useMswServer as setupMswServer } from "@/test/msw";

const server = setupMswServer();

const JEV_KEY = "APPA_PROVIDER_JEV_API_KEY";

/**
 * A dispatch whose jev key is bound to an organization GitHub App credential,
 * whose installation token GitHub answers with `status`.
 */
async function failedDispatch(params: {
  organizationId: string;
  userId: string;
  installationId: string;
  status: number;
}) {
  const key = `jev-app-${params.installationId}`;
  await RuntimeCredentialDefinitionModel.create({
    organizationId: params.organizationId,
    createdBy: params.userId,
    definition: {
      key,
      name: "Jev App",
      kind: "github_app",
      description: "",
      icon: null,
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId: params.installationId,
      allowPersonal: false,
      allowOrganization: true,
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await RuntimeCredentialConnectionModel.upsert({
    organizationId: params.organizationId,
    scope: "organization",
    userId: null,
    credentialId: key,
    value: privateKey,
  });
  server.use(
    http.post(
      `https://api.github.com/app/installations/${params.installationId}/access_tokens`,
      () => new HttpResponse(null, { status: params.status }),
    ),
  );
  const content = `[policy]\nversion = 2\n[credentials]\n${JEV_KEY} = "${key}"\n[externals.jev]\ntoken_env = "${JEV_KEY}"\n`;
  return openappaFailure(
    await openappaDeclarations
      .dispatchPolicy({ organizationId: params.organizationId, content })
      .then(
        () => expect.unreachable("the dispatch policy resolved"),
        (error: unknown) => error,
      ),
  );
}

test("a bound credential its provider cannot mint now fails the dispatch as retryable", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const failure = await failedDispatch({
    organizationId: organization.id,
    userId: user.id,
    installationId: "503503",
    status: 503,
  });
  expect(failure.statusCode).toBe(503);
  expect(failure.shouldRetry).toBe(true);
});

test("a bound credential its provider refuses fails the dispatch as the organization's to fix", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const failure = await failedDispatch({
    organizationId: organization.id,
    userId: user.id,
    installationId: "404404",
    status: 404,
  });
  expect(failure.statusCode).toBe(500);
  expect(failure.shouldRetry).toBe(false);
});

test("a policy line wins, a stored binding fills what an included battery reads, and nothing else is applied", async ({
  makeOrganization,
}) => {
  const organizationId = (await makeOrganization()).id;
  const GITHUB_TOKEN = "APPA_PROVIDER_GITHUB_TOKEN";
  for (const [variable, credentialKey] of [
    [GITHUB_TOKEN, "stored-github"],
    // No included battery reads it, and the runtime refuses a variable no helper reads.
    [JEV_KEY, "stored-jev"],
  ])
    await OpenAppaCredentialBindingModel.upsert({
      organizationId,
      variable,
      credentialKey,
      updatedBy: null,
    });
  const included = `include = ["batteries/github/appa.toml"]\n\n[policy]\nversion = 2\n`;

  const filled = await openappaDeclarations.resolveWithBindings({
    organizationId,
    content: included,
  });
  expect(filled.resolution.credentials).toEqual({
    [GITHUB_TOKEN]: "stored-github",
  });
  expect(filled.credentialSource).toEqual({ [GITHUB_TOKEN]: "binding" });
  // The bound text says exactly what the bound resolution says.
  expect(
    (
      await openappaDeclarations.resolve({
        organizationId,
        content: filled.content,
      })
    ).credentials,
  ).toEqual(filled.resolution.credentials);

  const declared = `${included}\n[credentials]\n${GITHUB_TOKEN} = "repo-github"\n`;
  const won = await openappaDeclarations.resolveWithBindings({
    organizationId,
    content: declared,
  });
  expect(won.content).toBe(declared);
  expect(won.resolution.credentials).toEqual({ [GITHUB_TOKEN]: "repo-github" });
  expect(won.credentialSource).toEqual({ [GITHUB_TOKEN]: "policy" });
});
