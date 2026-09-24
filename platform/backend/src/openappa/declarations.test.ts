import { generateKeyPairSync } from "node:crypto";
import { HttpResponse, http } from "msw";
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
