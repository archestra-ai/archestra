import { generateKeyPairSync } from "node:crypto";
import { parseOpenappaDeclarations } from "@archestra/openappa-rs";
import { HttpResponse, http } from "msw";
import config from "@/config";
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
  onUnreadable?: (unreadable: { variable: string; key: string }[]) => void;
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
      .dispatchPolicy({
        organizationId: params.organizationId,
        content,
        onUnreadable: params.onUnreadable,
      })
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

test("a dispatch names every bound credential it could not read, whether it resolves or rejects", async ({
  makeOrganization,
  makeUser,
}) => {
  const organizationId = (await makeOrganization()).id;
  const userId = (await makeUser()).id;
  const key = "jev-without-value";
  await RuntimeCredentialDefinitionModel.create({
    organizationId,
    createdBy: userId,
    definition: {
      key,
      name: "Jev",
      kind: "secret",
      description: "",
      icon: null,
      allowPersonal: false,
      allowOrganization: true,
    },
  });
  const unset: unknown[] = [];
  const resolved = await openappaDeclarations.dispatchPolicy({
    organizationId,
    content: `[policy]\nversion = 2\n[credentials]\n${JEV_KEY} = "${key}"\n[externals.jev]\ntoken_env = "${JEV_KEY}"\n`,
    onUnreadable: (unreadable) => unset.push(...unreadable),
  });
  expect(resolved.credentials).toEqual({});
  expect(unset).toEqual([{ variable: JEV_KEY, key }]);

  const failing: unknown[] = [];
  const failure = await failedDispatch({
    organizationId,
    userId,
    installationId: "502502",
    status: 503,
    onUnreadable: (unreadable) => failing.push(...unreadable),
  });
  expect(failure.statusCode).toBe(503);
  expect(failing).toEqual([{ variable: JEV_KEY, key: "jev-app-502502" }]);
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

test("quoted token_env readers are fingerprinted from parsed declarations, not rendered keys", async () => {
  const names = ['say"hi', "say\\hi", "say'hi", "p5.note"] as const;
  for (const name of names) {
    const original = namedExternal(name, "http://127.0.0.1:9/a");
    const reordered = namedExternal(name, "http://127.0.0.1:9/a", {
      reorder: true,
    });
    const retarget = namedExternal(name, "https://attacker.example/a");
    const withRule = `${original}\n[[policy.tool]]\nname = "notes__keep"\ndelta = {}\n`;
    const [kept, equivalent, moved, ruled] = await Promise.all(
      [original, reordered, retarget, withRule].map((content) =>
        openappaDeclarations.resolve({ organizationId: "unused", content }),
      ),
    );
    const native = await parseOpenappaDeclarations(original);
    expect(native.tokenEnvReaders.map((reader) => reader.reader)).toEqual([
      kept.tokenEnvReaders[0]?.reader,
    ]);
    const destination = kept.tokenEnvReaders[0]?.destination ?? "";
    expect(destination).toContain("http://127.0.0.1:9/a");
    expect(destination.startsWith("unresolved:")).toBe(false);
    expect(equivalent.tokenEnvReaders[0]?.destination).toBe(destination);
    expect(ruled.tokenEnvReaders[0]?.destination).toBe(destination);
    expect(moved.tokenEnvReaders[0]?.destination).not.toBe(destination);
    expect(moved.tokenEnvReaders[0]?.destination).toContain(
      "https://attacker.example/a",
    );
  }
  const quoted = await parseOpenappaDeclarations(
    namedExternal('say"hi', "http://127.0.0.1:9/a"),
  );
  expect(quoted.tokenEnvReaders[0]?.reader).toBe(
    `externals.annotators.'say"hi'`,
  );

  const anthropic = await openappaDeclarations.resolve({
    organizationId: "unused",
    content: llmExternal("anthropic"),
  });
  const openai = await openappaDeclarations.resolve({
    organizationId: "unused",
    content: llmExternal("openai"),
  });
  const anthropicReordered = await openappaDeclarations.resolve({
    organizationId: "unused",
    content: llmExternal("anthropic", true),
  });
  expect(anthropic.tokenEnvReaders[0]?.destination).toContain("anthropic");
  expect(
    anthropic.tokenEnvReaders[0]?.destination.startsWith("unresolved:"),
  ).toBe(false);
  expect(anthropicReordered.tokenEnvReaders[0]?.destination).toBe(
    anthropic.tokenEnvReaders[0]?.destination,
  );
  expect(openai.tokenEnvReaders[0]?.destination).not.toBe(
    anthropic.tokenEnvReaders[0]?.destination,
  );

  const echo = await openappaDeclarations.resolve({
    organizationId: "unused",
    content: commandExternal("echo"),
  });
  const printf = await openappaDeclarations.resolve({
    organizationId: "unused",
    content: commandExternal("printf"),
  });
  expect(echo.tokenEnvReaders[0]?.destination.startsWith("unresolved:")).toBe(
    false,
  );
  expect(printf.tokenEnvReaders[0]?.destination).not.toBe(
    echo.tokenEnvReaders[0]?.destination,
  );
});

function namedExternal(
  name: string,
  url: string,
  options?: { reorder?: boolean },
): string {
  const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  const fields = options?.reorder
    ? `token_env = 'APPA_P5_ANNOTATOR_TOKEN'\nurl = '${url}'`
    : `url = "${url}"\ntoken_env = "APPA_P5_ANNOTATOR_TOKEN"`;
  return `[policy]\nversion = 2\n[[policy.annotator]]\nname = ${JSON.stringify(name)}\n[externals.annotators.${key}]\n${fields}\n`;
}

function llmExternal(provider: string, reorder = false): string {
  const fields = reorder
    ? `token_env = 'APPA_LLM_TOKEN'\nmodel = 'claude'\nprovider = '${provider}'`
    : `provider = "${provider}"\nmodel = "claude"\ntoken_env = "APPA_LLM_TOKEN"`;
  return `[policy]\nversion = 2\n[externals.llm]\n${fields}\n`;
}

function commandExternal(command: string): string {
  return `[policy]\nversion = 2\n[externals.authorities.review]\ncommand = "${command}"\ntoken_env = "APPA_P5_ANNOTATOR_TOKEN"\n`;
}

test("publishes the proxy body limit as the default result cap of a policy that states none", () => {
  const variable = "APPA_ARCHESTRA_MAX_BODY_BYTES";
  const original = config.api.bodyLimit;
  const prior = process.env[variable];
  try {
    openappaDeclarations.publishBridgeToken();
    expect(process.env[variable]).toBe(String(original));

    config.api.bodyLimit = 5 * 1024 * 1024;
    openappaDeclarations.publishBridgeToken();
    expect(process.env[variable]).toBe(String(5 * 1024 * 1024));
  } finally {
    config.api.bodyLimit = original;
    if (prior === undefined) delete process.env[variable];
    else process.env[variable] = prior;
  }
});
