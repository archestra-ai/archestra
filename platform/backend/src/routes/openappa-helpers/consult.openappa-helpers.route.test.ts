import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { openappaBatteriesService } from "@/openappa/batteries";
import { openappaDeclarations } from "@/openappa/declarations";
import { openappaHelperBridge } from "@/openappa/helper-bridge";
import { OPENAPPA_HELPERS_PREFIX } from "@/routes/route-paths";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import routes from "./openappa-helpers.routes";

const CREDENTIAL_VALUE = "gh-token-value-under-test";

const envelope = {
  version: 1,
  kind: "annotation",
  annotator: "github.repository-visibility",
  arguments: { owner: "example", repo: "widgets" },
};

describe("battery helper bridge", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let userId: string;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    app = createFastifyInstance();
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
    // This file shares its worker with the rest of the mock-free project, so a
    // sandbox spy left standing would serve the next file's tests too.
    vi.restoreAllMocks();
  });

  const consult = (params: {
    installId: string;
    externalName?: string;
    authorization?: string;
    remoteAddress?: string;
    payload?: unknown;
  }) =>
    app.inject({
      method: "POST",
      url: `${OPENAPPA_HELPERS_PREFIX}/${params.installId}/${params.externalName ?? "github.repository-visibility"}`,
      headers:
        params.authorization === undefined
          ? {}
          : { authorization: params.authorization },
      remoteAddress: params.remoteAddress ?? "127.0.0.1",
      payload: params.payload ?? envelope,
    });
  const bridgeBearer = () => `Bearer ${openappaDeclarations.bridgeToken}`;

  const installGithub = async (
    catalogId: string,
    credentialBindings: Record<string, string> = {},
  ) =>
    attach({
      organizationId,
      batteryName: "github",
      catalogId,
      credentialBindings,
    });

  /** An install whose credential resolves, so a consult reaches the sandbox. */
  const installBoundGithub = async (
    makeInternalMcpCatalog: (params: {
      organizationId: string;
    }) => Promise<{ id: string }>,
  ) => {
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: userId,
      definition: {
        key: "github-token",
        name: "GitHub token",
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
      credentialId: "github-token",
      value: CREDENTIAL_VALUE,
    });
    return installGithub(
      (await makeInternalMcpCatalog({ organizationId })).id,
      { APPA_PROVIDER_GITHUB_TOKEN: "github-token" },
    );
  };

  /** The sandbox is a process boundary; the bridge's own logic stays real. */
  const stubSandbox = (
    result: Pick<
      Awaited<ReturnType<typeof sandboxRuntimeService.runCommand>>,
      "exitCode" | "stdout" | "stderr"
    >,
  ) => {
    vi.spyOn(sandboxRuntimeService, "attach").mockResolvedValue(undefined);
    return vi.spyOn(sandboxRuntimeService, "runCommand").mockResolvedValue({
      ...result,
      durationMs: 1,
      timedOut: false,
      truncated: false,
    });
  };

  test("only the runtime's bearer over loopback reaches a helper", async ({
    makeInternalMcpCatalog,
  }) => {
    const install = await installGithub(
      (await makeInternalMcpCatalog({ organizationId })).id,
    );
    expect((await consult({ installId: install.id })).statusCode).toBe(401);
    expect(
      (
        await consult({
          installId: install.id,
          authorization: "Bearer not-the-bridge-token",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await consult({
          installId: install.id,
          authorization: bridgeBearer(),
          remoteAddress: "10.0.0.7",
        })
      ).statusCode,
    ).toBe(403);
  });

  test("a rejected caller is turned away before its body is looked at", async ({
    makeInternalMcpCatalog,
  }) => {
    const install = await installGithub(
      (await makeInternalMcpCatalog({ organizationId })).id,
    );
    // A body the consult schema refuses, proven by sending it as the runtime.
    const malformed = ["not", "an", "envelope"];
    expect(
      (
        await consult({
          installId: install.id,
          authorization: bridgeBearer(),
          payload: malformed,
        })
      ).statusCode,
    ).toBe(400);
    // The same body from off-box is turned away on where it came from, not on
    // what it contains: a 400 would mean it was parsed and validated first.
    expect(
      (
        await consult({
          installId: install.id,
          authorization: bridgeBearer(),
          remoteAddress: "10.0.0.7",
          payload: malformed,
        })
      ).statusCode,
    ).toBe(403);
  });

  test("an unknown, removed or helper-less install is not found", async ({
    makeInternalMcpCatalog,
  }) => {
    expect(
      (
        await consult({
          installId: "00000000-0000-0000-0000-000000000000",
          authorization: bridgeBearer(),
        })
      ).statusCode,
    ).toBe(404);
    // A battery whose declaration is gone loses its row, and its helper URL with it.
    const removed = await attach({
      organizationId,
      batteryName: "github",
      catalogId: (await makeInternalMcpCatalog({ organizationId })).id,
      credentialBindings: {},
    });
    await OpenAppaBatteryInstallModel.replaceAll({ organizationId, rows: [] });
    expect(
      (await consult({ installId: removed.id, authorization: bridgeBearer() }))
        .statusCode,
    ).toBe(404);
    const enabled = await installGithub(
      (await makeInternalMcpCatalog({ organizationId })).id,
    );
    expect(
      (
        await consult({
          installId: enabled.id,
          externalName: "no-such-helper",
          authorization: bridgeBearer(),
        })
      ).statusCode,
    ).toBe(404);
  });

  test("a helper whose credential is unbound or unresolvable answers 502, never a denial", async ({
    makeInternalMcpCatalog,
  }) => {
    const unbound = await installGithub(
      (await makeInternalMcpCatalog({ organizationId })).id,
    );
    expect(
      (await consult({ installId: unbound.id, authorization: bridgeBearer() }))
        .statusCode,
    ).toBe(502);
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: userId,
      definition: {
        key: "github-token",
        name: "GitHub token",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    const bound = await installGithub(
      (await makeInternalMcpCatalog({ organizationId })).id,
      { APPA_PROVIDER_GITHUB_TOKEN: "github-token" },
    );
    // Defined but no organization value stored yet.
    expect(
      (await consult({ installId: bound.id, authorization: bridgeBearer() }))
        .statusCode,
    ).toBe(502);
  });

  test("a helper that exits non-zero answers 502", async ({
    makeInternalMcpCatalog,
  }) => {
    const install = await installBoundGithub(makeInternalMcpCatalog);
    stubSandbox({ exitCode: 3, stdout: "", stderr: "traceback" });

    const response = await consult({
      installId: install.id,
      authorization: bridgeBearer(),
    });

    expect(response.statusCode).toBe(502);
  });

  test("the last line a helper wrote to stderr is passed through as X-Appa-Diagnostics", async ({
    makeInternalMcpCatalog,
  }) => {
    const install = await installBoundGithub(makeInternalMcpCatalog);
    const cases = [
      {
        result: {
          exitCode: 3,
          stdout: "",
          stderr: "starting\nrate limited\n\n",
        },
        status: 502,
        diagnostics: "rate limited",
      },
      {
        result: {
          exitCode: 0,
          stdout: JSON.stringify({ version: 1, answer: {} }),
          stderr: "cache miss",
        },
        status: 200,
        diagnostics: "cache miss",
      },
      { result: { exitCode: 3, stdout: "", stderr: "" }, status: 502 },
    ];
    for (const { result, status, diagnostics } of cases) {
      stubSandbox(result);
      const response = await consult({
        installId: install.id,
        authorization: bridgeBearer(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers["x-appa-diagnostics"]).toBe(diagnostics);
      vi.restoreAllMocks();
    }
  });

  test("a last stderr line that is not a whole, valid header value is dropped", async ({
    makeInternalMcpCatalog,
  }) => {
    const install = await installBoundGithub(makeInternalMcpCatalog);
    for (const stderr of [
      "carriage\rreturn",
      "not latin1: \u{1F4A5}",
      `short\n${"a".repeat(9 * 1024)}`,
    ]) {
      stubSandbox({ exitCode: 3, stdout: "", stderr });
      const response = await consult({
        installId: install.id,
        authorization: bridgeBearer(),
      });
      expect(response.statusCode).toBe(502);
      expect(response.headers["x-appa-diagnostics"]).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  test("the bound credential reaches the helper's environment and nothing else", async ({
    makeInternalMcpCatalog,
  }) => {
    const install = await installBoundGithub(makeInternalMcpCatalog);
    const run = stubSandbox({
      exitCode: 0,
      stdout: JSON.stringify({ version: 1, answer: {} }),
      stderr: "",
    });

    expect(
      (await consult({ installId: install.id, authorization: bridgeBearer() }))
        .statusCode,
    ).toBe(200);

    const params = run.mock.calls[0]?.[0];
    expect(params?.secretEnv).toEqual([
      { name: "APPA_PROVIDER_GITHUB_TOKEN", value: CREDENTIAL_VALUE },
    ]);
    // Everything the run carries besides the secret channel: the mounted
    // battery files, the command, the envelope on stdin.
    const { secretEnv: _secret, ...rest } = params ?? {};
    expect(JSON.stringify(rest)).not.toContain(CREDENTIAL_VALUE);
  });

  test("consults beyond half the sandbox pool are refused as busy", async ({
    makeInternalMcpCatalog,
  }) => {
    const unbound = await installGithub(
      (await makeInternalMcpCatalog({ organizationId })).id,
    );
    const params = {
      installId: unbound.id,
      externalName: "github.repository-visibility",
      request: JSON.stringify(envelope),
    };
    const pool = config.daggerRuntime.maxConcurrent;
    config.daggerRuntime.maxConcurrent = 1;
    let outcomes: string[];
    try {
      outcomes = (
        await Promise.all([
          openappaHelperBridge.consult(params),
          openappaHelperBridge.consult(params),
        ])
      ).map((outcome) => outcome.kind);
    } finally {
      config.daggerRuntime.maxConcurrent = pool;
    }
    expect(outcomes.sort()).toEqual(["busy", "failed"]);
    // The share is released once the first consult settled.
    expect((await openappaHelperBridge.consult(params)).kind).toBe("failed");
  });

  test.skipIf(!config.daggerRuntime.enabled)(
    "a bound helper runs in the sandbox with the envelope on stdin and the credential in its environment",
    async ({ makeInternalMcpCatalog }) => {
      const files = [
        {
          path: "appa-package.toml",
          text: 'schema = 1\nname = "acme"\ndescription = "Echo helper"\n[battery]\npolicy = "appa.toml"\nhosts = []\nnamespaces = ["acme"]\nhelpers = ["echo.py"]\n',
        },
        {
          path: "appa.toml",
          text: '[policy]\nversion = 2\n[[policy.annotator]]\nname = "acme.echo"\nranks = ["suspicious"]\naudiences = ["self"]\nmarks = []\n[externals.annotators."acme.echo"]\ncommand = ["python3", "echo.py"]\ntoken_env = "APPA_PROVIDER_ACME_TOKEN"\n[[policy.tool]]\nname = "mcp/acme/list"\ndelta = {}\n',
        },
        {
          path: "echo.py",
          text: 'import hashlib, json, os, sys\nrequest = json.load(sys.stdin)\ntoken = os.environ["APPA_PROVIDER_ACME_TOKEN"]\nprint(json.dumps({"version": 1, "answer": {"echo": request["arguments"], "token_sha256": hashlib.sha256(token.encode()).hexdigest()}}))\n',
        },
      ];
      await openappaBatteriesService.uploadPackage({
        userId,
        organizationId,
        name: "acme",
        files,
      });
      await RuntimeCredentialDefinitionModel.create({
        organizationId,
        createdBy: userId,
        definition: {
          key: "acme-token",
          name: "Acme token",
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
        credentialId: "acme-token",
        value: "acme-secret-value",
      });
      const install = await attach({
        organizationId,
        batteryName: "acme",
        catalogId: (await makeInternalMcpCatalog({ organizationId })).id,
        credentialBindings: { APPA_PROVIDER_ACME_TOKEN: "acme-token" },
      });
      // Warm the engine session first: the bridge budget covers one consult,
      // not the CLI download and image pull of a cold session.
      await sandboxRuntimeService.attach("consult.openappa-helpers.test");
      const timed = async () => {
        const startedAt = Date.now();
        const response = await consult({
          installId: install.id,
          externalName: "acme.echo",
          authorization: bridgeBearer(),
        });
        return { response, ms: Date.now() - startedAt };
      };
      const first = await timed();
      const second = await timed();
      console.info(
        `[helper wall-clock] first=${first.ms}ms second=${second.ms}ms`,
      );
      const response = second.response;
      expect(first.response.statusCode).toBe(200);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        version: 1,
        answer: {
          echo: envelope.arguments,
          token_sha256: createHash("sha256")
            .update("acme-secret-value")
            .digest("hex"),
        },
      });
    },
    // A cold engine session downloads the CLI and pulls the base image.
    180_000,
  );
});

/**
 * A derived install row the test relies on. Rows are only ever written as a
 * whole organization, so an attach carries the rows already there.
 */
async function attach(params: {
  organizationId: string;
  batteryName: string;
  catalogId: string;
  credentialBindings: Record<string, string>;
}) {
  const { organizationId, ...row } = params;
  const existing = await OpenAppaBatteryInstallModel.list(organizationId);
  const rows = await OpenAppaBatteryInstallModel.replaceAll({
    organizationId,
    rows: [
      ...existing.map((install) => ({
        batteryName: install.batteryName,
        catalogId: install.catalogId,
        status: install.status,
        packageHash: install.packageHash,
        lastError: install.lastError,
        credentialBindings: install.credentialBindings,
      })),
      { ...row, status: "active" as const, packageHash: null, lastError: null },
    ],
  });
  const install = rows.at(-1);
  if (!install) throw new Error("the battery install was not written");
  return install;
}
