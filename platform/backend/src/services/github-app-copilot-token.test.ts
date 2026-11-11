import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  classifyCopilotAppRejection,
  encodeGithubAppReference,
  type GithubAppCredential,
  githubAppKeyFingerprint,
  githubOrganizationDisplayName,
  validateGithubAppPrivateKey,
} from "@/services/github-app-copilot-token";
import { createGithubCopilotFetch } from "@/services/github-copilot-token";
import type { ApiError } from "@/types/api";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Installation tokens are cached per installation, so each test uses its own. */
let installationCounter = 1000;
function uniqueCredential(
  overrides?: Partial<GithubAppCredential>,
): GithubAppCredential {
  installationCounter += 1;
  return {
    appId: "4242",
    installationId: String(installationCounter),
    privateKey,
    githubUrl: "https://github.com",
    organization: "my-org",
    ...overrides,
  };
}

function mintResponse(token = "ghs_installation") {
  return Response.json(
    { token, expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { status: 201 },
  );
}

function isMintCall(input: unknown): boolean {
  return String(input).includes("/access_tokens");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("githubAppKeyFingerprint", () => {
  test("matches GitHub's SHA256 format of the public key", () => {
    const der = createPublicKey(privateKey).export({
      type: "spki",
      format: "der",
    });
    const expected = `SHA256:${createHash("sha256").update(der).digest("base64")}`;

    expect(githubAppKeyFingerprint(privateKey)).toBe(expected);
    expect(
      validateGithubAppPrivateKey({ appId: " 42 ", privateKey }),
    ).toMatchObject({ appId: "42", fingerprint: expected });
  });

  test("refuses a bad key or App ID without echoing the key", () => {
    expect(() =>
      validateGithubAppPrivateKey({ appId: "abc", privateKey }),
    ).toThrow("GitHub App ID must be a number.");
    try {
      githubAppKeyFingerprint("secret-not-a-pem");
      expect.unreachable();
    } catch (error) {
      expect((error as ApiError).statusCode).toBe(400);
      expect((error as Error).message).not.toContain("secret-not-a-pem");
    }
  });
});

describe("createGithubCopilotFetch with a GitHub App credential", () => {
  test("sends the installation token with only the Copilot runtime integration id", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      isMintCall(input) ? mintResponse() : Response.json({ data: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const copilotFetch = createGithubCopilotFetch({
      githubToken: undefined,
      appCredential: credential,
    });
    const response = await copilotFetch("https://api.githubcopilot.com/models");

    expect(response.status).toBe(200);
    const [mintUrl] = fetchMock.mock.calls[0] as [string];
    expect(mintUrl).toBe(
      `https://api.github.com/app/installations/${credential.installationId}/access_tokens`,
    );
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer ghs_installation");
    expect(headers.get("copilot-integration-id")).toBe("copilot-developer-cli");
    expect(headers.has("editor-version")).toBe(false);
  });

  test("mints a fresh token and retries once on 401", async () => {
    const credential = uniqueCredential();
    const mints = ["ghs_first", "ghs_second"];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (isMintCall(input)) return mintResponse(mints.shift());
      return new Headers(init?.headers).get("authorization") ===
        "Bearer ghs_second"
        ? Response.json({ ok: true })
        : Response.json({ message: "expired" }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createGithubCopilotFetch({
      githubToken: undefined,
      appCredential: credential,
    })("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("turns 'App requests not enabled' into a fix that quotes GitHub", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        isMintCall(input)
          ? mintResponse()
          : Response.json(
              {
                message:
                  "Copilot requests from GitHub App installations are not enabled for this organization",
              },
              { status: 403 },
            ),
      ),
    );

    const response = await createGithubCopilotFetch({
      githubToken: undefined,
      appCredential: credential,
    })("https://api.githubcopilot.com/models");
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(401);
    // An enterprise can hold the plan and the policy; never claim a missing plan.
    expect(body.error.message).toContain(
      "my-org doesn't allow Copilot requests from GitHub Apps. It needs Copilot Business or Enterprise, with requests from Apps allowed by an owner of the organization or its enterprise.",
    );
    expect(body.error.message).toContain(
      'GitHub said: "Copilot requests from GitHub App installations are not enabled for this organization"',
    );
  });

  test("passes request validation errors through unchanged", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        isMintCall(input)
          ? mintResponse()
          : Response.json(
              { error: { message: "messages must be non-empty" } },
              { status: 400 },
            ),
      ),
    );

    const response = await createGithubCopilotFetch({
      githubToken: undefined,
      appCredential: credential,
    })("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("messages must be non-empty");
  });
});

describe("createGithubCopilotFetch with a GitHub App credential, refusals", () => {
  function copilotAnswer(status: number, message: string) {
    return vi.fn(async (input: unknown) =>
      isMintCall(input)
        ? mintResponse()
        : Response.json({ message }, { status }),
    );
  }

  test("refuses a GitHub App reference a caller sends, before reading anything", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const callerValue = encodeGithubAppReference({
      ref: { organizationId: "another-org", credentialId: "their-app" },
      installationId: "1",
      organization: "their-org",
      githubUrl: "https://github.com",
    });

    const response = await createGithubCopilotFetch({
      githubToken: callerValue,
    })("https://api.githubcopilot.com/models");

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("passes a refusal of one request (a model the policy blocks) through as a 403", async () => {
    vi.stubGlobal(
      "fetch",
      copilotAnswer(
        403,
        "The requested model is not enabled for your organization",
      ),
    );

    const response = await createGithubCopilotFetch({
      githubToken: undefined,
      appCredential: uniqueCredential(),
    })("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: "{}",
    });
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(403);
    expect(body.error.message).toBe(
      'GitHub Copilot answered 403. GitHub said: "The requested model is not enabled for your organization"',
    );
  });

  test("names a missing Copilot Requests permission", async () => {
    vi.stubGlobal(
      "fetch",
      copilotAnswer(403, "Resource not accessible by integration"),
    );

    const response = await createGithubCopilotFetch({
      githubToken: undefined,
      appCredential: uniqueCredential(),
    })("https://api.githubcopilot.com/models");
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(401);
    expect(body.error.message).toContain(
      "Check that it has the Copilot Requests permission",
    );
  });

  test("answers a GitHub rate limit while minting a token as a passing outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { message: "API rate limit exceeded for installation" },
          { status: 429, headers: { "retry-after": "30" } },
        ),
      ),
    );

    const response = await createGithubCopilotFetch({
      githubToken: undefined,
      appCredential: uniqueCredential(),
    })("https://api.githubcopilot.com/models");

    expect(response.status).toBe(503);
  });
});

describe("classifyCopilotAppRejection", () => {
  test("tells a missing permission from an organization that turns Apps off", () => {
    expect(
      classifyCopilotAppRejection({
        status: 403,
        githubMessage: "Resource not accessible by integration",
      }),
    ).toBe("missing_permission");
    expect(
      classifyCopilotAppRejection({
        status: 403,
        githubMessage:
          "Copilot requests from GitHub App installations are not enabled for this organization",
      }),
    ).toBe("apps_disabled");
    expect(
      classifyCopilotAppRejection({
        status: 400,
        githubMessage: "missing or invalid Copilot-Integration-Id",
      }),
    ).toBe("integration_id");
  });

  test("does not take a message about an application, or any other 403, for the App's own refusal", () => {
    for (const githubMessage of [
      "This model is not available for this application",
      "Your organization's policy blocks this model",
    ])
      expect(
        classifyCopilotAppRejection({ status: 403, githubMessage }),
      ).toBeNull();
  });
});

describe("githubOrganizationDisplayName", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A plan whose App credential is gone: GitHub is asked anonymously. */
  function plan() {
    const organizationId = randomUUID();
    return {
      organizationId,
      value: encodeGithubAppReference({
        ref: { organizationId, credentialId: randomUUID() },
        installationId: "7",
        organization: "acme",
        githubUrl: "https://github.com",
      }),
    };
  }
  const lookups = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(
      ([input]) => String(input) === "https://api.github.com/orgs/acme",
    );

  test("asks GitHub once per installation and reads the trimmed name", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      Response.json({ login: "acme", name: "  Acme Inc " }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const acme = plan();

    const names = await Promise.all([
      githubOrganizationDisplayName(acme),
      githubOrganizationDisplayName(acme),
    ]);
    names.push(await githubOrganizationDisplayName(acme));

    expect(names).toEqual(["Acme Inc", "Acme Inc", "Acme Inc"]);
    expect(lookups(fetchMock)).toHaveLength(1);
  });

  test("is null when GitHub has no name or refuses, and waits before asking again", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      Response.json({ login: "acme", name: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await githubOrganizationDisplayName(plan())).toBeNull();

    fetchMock.mockImplementation(
      async () => new Response(null, { status: 404 }),
    );
    const refused = plan();
    expect(await githubOrganizationDisplayName(refused)).toBeNull();
    expect(await githubOrganizationDisplayName(refused)).toBeNull();
    expect(lookups(fetchMock)).toHaveLength(2);
  });

  test("never reads a reference into another organization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const acme = plan();

    expect(
      await githubOrganizationDisplayName({
        value: acme.value,
        organizationId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await githubOrganizationDisplayName({
        value: "ghp_not_a_reference",
        organizationId: acme.organizationId,
      }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("gives up waiting after a few seconds and fills the cache once GitHub answers", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      (_input: unknown, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const acme = plan();

    const started = Date.now();
    expect(await githubOrganizationDisplayName(acme)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);

    answer(Response.json({ login: "acme", name: "Acme Inc" }));
    await vi.waitFor(async () =>
      expect(await githubOrganizationDisplayName(acme)).toBe("Acme Inc"),
    );
    expect(lookups(fetchMock)).toHaveLength(1);
  });
});
