import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createGithubAppJwt,
  decodeGithubAppCredential,
  encodeGithubAppCredential,
  type GithubAppCredential,
  githubAppCopilotTokenManager,
  githubAppIntegrationIdCandidates,
  validateGithubAppCredential,
} from "@/services/github-app-copilot-token";
import {
  createGithubCopilotFetch,
  detectGithubAppWireMode,
} from "@/services/github-copilot-token";
import type { ApiError } from "@/types/api";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** The manager caches by credential, so each test uses its own installation. */
let installationCounter = 1000;
function uniqueCredential(): GithubAppCredential {
  installationCounter += 1;
  return {
    appId: "4242",
    installationId: String(installationCounter),
    privateKey,
  };
}

function mintResponse(token = "ghs_installation", expiresInMs = 3600_000) {
  return Response.json(
    { token, expires_at: new Date(Date.now() + expiresInMs).toISOString() },
    { status: 201 },
  );
}

function isMintCall(input: unknown): boolean {
  return String(input).includes("/app/installations/");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub App credential marker", () => {
  test("round-trips through encode and decode", () => {
    const credential = uniqueCredential();
    const encoded = encodeGithubAppCredential(credential);

    expect(encoded.startsWith("github-app:")).toBe(true);
    expect(encoded).not.toContain("BEGIN");
    expect(decodeGithubAppCredential(encoded)).toEqual(credential);
  });

  test("decodes nothing from other credentials or a corrupted payload", () => {
    expect(decodeGithubAppCredential("gho_personal")).toBeNull();
    expect(decodeGithubAppCredential("github-app:not-json")).toBeNull();
    expect(
      decodeGithubAppCredential(
        `github-app:${Buffer.from('{"appId":"1"}').toString("base64url")}`,
      ),
    ).toBeNull();
  });
});

describe("validateGithubAppCredential", () => {
  test("accepts numeric ids and an RSA PEM", () => {
    expect(
      validateGithubAppCredential({
        appId: " 4242 ",
        installationId: "99",
        privateKey,
      }),
    ).toMatchObject({ appId: "4242", installationId: "99" });
  });

  test("refuses non-numeric ids and a bad key without echoing it", () => {
    expect(() =>
      validateGithubAppCredential({
        appId: "abc",
        installationId: "1",
        privateKey,
      }),
    ).toThrow("GitHub App ID must be a number.");
    expect(() =>
      validateGithubAppCredential({
        appId: "1",
        installationId: "x",
        privateKey,
      }),
    ).toThrow("installation ID must be a number");
    try {
      validateGithubAppCredential({
        appId: "1",
        installationId: "2",
        privateKey: "secret-not-a-pem",
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ApiError).statusCode).toBe(400);
      expect((error as Error).message).not.toContain("secret-not-a-pem");
    }
  });
});

describe("createGithubAppJwt", () => {
  test("signs an RS256 JWT with the App ID as issuer and a 9-minute window", () => {
    const jwt = createGithubAppJwt({
      appId: "4242",
      privateKey,
      nowSeconds: 1_000_000,
    });
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: 1_000_000 - 60,
      exp: 1_000_000 + 540,
      iss: "4242",
    });
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });
});

describe("githubAppCopilotTokenManager", () => {
  test("mints with the App JWT and Copilot permission, then caches", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi.fn().mockResolvedValue(mintResponse());
    vi.stubGlobal("fetch", fetchMock);

    const first =
      await githubAppCopilotTokenManager.getInstallationToken(credential);
    const second =
      await githubAppCopilotTokenManager.getInstallationToken(credential);

    expect(first.token).toBe("ghs_installation");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.github.com/app/installations/${credential.installationId}/access_tokens`,
    );
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toMatch(
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
    expect(JSON.parse(init.body)).toEqual({
      permissions: { organization_copilot_requests: "read" },
    });
  });

  test("re-mints a token within five minutes of expiry", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mintResponse("ghs_old", 4 * 60_000))
      .mockResolvedValueOnce(mintResponse("ghs_new"));
    vi.stubGlobal("fetch", fetchMock);

    await githubAppCopilotTokenManager.getInstallationToken(credential);
    const refreshed =
      await githubAppCopilotTokenManager.getInstallationToken(credential);

    expect(refreshed.token).toBe("ghs_new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("single-flights concurrent mints", async () => {
    const credential = uniqueCredential();
    let resolveMint: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveMint = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = Promise.all([
      githubAppCopilotTokenManager.getInstallationToken(credential),
      githubAppCopilotTokenManager.getInstallationToken(credential),
    ]);
    resolveMint(mintResponse());
    const [a, b] = await pending;

    expect(a.token).toBe(b.token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("surfaces GitHub's rejection message", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { message: "A JSON web token could not be decoded" },
            { status: 401 },
          ),
        ),
    );

    await expect(
      githubAppCopilotTokenManager.getInstallationToken(credential),
    ).rejects.toThrow(
      "GitHub rejected the App installation token request (401): A JSON web token could not be decoded",
    );
  });
});

/** GET /app answer for the App the credential belongs to. */
function appResponse() {
  return Response.json({
    id: 4242,
    slug: "acme-copilot",
    client_id: "Iv23abc",
  });
}

function isAppCall(input: unknown): boolean {
  return String(input).endsWith("/app");
}

const mismatch = () =>
  Response.json(
    {
      message:
        "bad request: the Copilot-Integration-Id header does not match the GitHub App that issued this installation access token",
    },
    { status: 400 },
  );

describe("githubAppIntegrationIdCandidates", () => {
  test("orders client id, slug, numeric id and falls back to the App ID", () => {
    expect(
      githubAppIntegrationIdCandidates({
        identity: { id: 4242, slug: "acme-copilot", clientId: "Iv23abc" },
        appId: "4242",
      }),
    ).toEqual(["Iv23abc", "acme-copilot", "4242"]);
    expect(
      githubAppIntegrationIdCandidates({ identity: null, appId: "7" }),
    ).toEqual(["7"]);
  });
});

describe("detectGithubAppWireMode", () => {
  test("uses the client id bare (B) when Copilot accepts it", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (isMintCall(input)) return mintResponse();
      if (isAppCall(input)) return appResponse();
      const headers = new Headers(init?.headers);
      return headers.get("copilot-integration-id") === "Iv23abc"
        ? Response.json({ data: [] })
        : mismatch();
    });
    vi.stubGlobal("fetch", fetchMock);

    const mode = await detectGithubAppWireMode({ credential });

    expect(mode).toEqual({ mode: "B", integrationId: "Iv23abc" });
    const probe = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/models"),
    ) as unknown as [string, RequestInit];
    const headers = new Headers(probe[1].headers);
    expect(headers.get("authorization")).toBe("Bearer ghs_installation");
    expect(headers.has("editor-version")).toBe(false);
  });

  test("moves past a 'does not match' 400 to the next candidate, with editor headers (A)", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (isMintCall(input)) return mintResponse();
        if (isAppCall(input)) return appResponse();
        const headers = new Headers(init?.headers);
        return headers.get("copilot-integration-id") === "acme-copilot" &&
          headers.has("editor-version")
          ? Response.json({ data: [] })
          : mismatch();
      }),
    );

    expect(await detectGithubAppWireMode({ credential })).toEqual({
      mode: "A",
      integrationId: "acme-copilot",
    });
  });

  test("falls back to the App ID when GET /app fails", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (isMintCall(input)) return mintResponse();
        if (isAppCall(input))
          return Response.json({ message: "Not Found" }, { status: 404 });
        return new Headers(init?.headers).get("copilot-integration-id") ===
          credential.appId
          ? Response.json({ data: [] })
          : mismatch();
      }),
    );

    expect(await detectGithubAppWireMode({ credential })).toEqual({
      mode: "B",
      integrationId: credential.appId,
    });
  });

  test("ends with the token exchange (C) and lists every attempt", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (isMintCall(url)) return mintResponse("ghs_all_fail");
        if (isAppCall(url)) return appResponse();
        if (url.includes("copilot_internal"))
          return Response.json({ message: "Not Found" }, { status: 404 });
        return mismatch();
      }),
    );

    await expect(detectGithubAppWireMode({ credential })).rejects.toThrow(
      /B\(Iv23abc\): 400 .*does not match.*; A\(Iv23abc\): 400 .*; B\(acme-copilot\): 400 .*; A\(acme-copilot\): 400 .*; B\(4242\): 400 .*; A\(4242\): 400 .*; C: .*404/,
    );
  });

  test("stops at a 403 saying App-token requests are not enabled", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (isMintCall(input)) return mintResponse();
      if (isAppCall(input)) return appResponse();
      return Response.json(
        {
          message:
            "Copilot requests from GitHub App installations are not enabled for this organization",
        },
        { status: 403 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(detectGithubAppWireMode({ credential })).rejects.toThrow(
      /B\(Iv23abc\): 403 Copilot requests from GitHub App installations are not enabled/,
    );
    // Mint, GET /app and one probe: no further candidates were tried.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("createGithubCopilotFetch with a GitHub App credential", () => {
  test("sends the remembered integration id and retries a 401 once with a new token", async () => {
    const credential = uniqueCredential();
    githubAppCopilotTokenManager.setWireMode(credential, {
      mode: "B",
      integrationId: "Iv23abc",
    });
    const mints = ["ghs_first", "ghs_second"];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (isMintCall(input)) return mintResponse(mints.shift());
      const headers = new Headers(init?.headers);
      expect(headers.get("copilot-integration-id")).toBe("Iv23abc");
      return headers.get("authorization") === "Bearer ghs_second"
        ? Response.json({ ok: true })
        : Response.json({ message: "expired" }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const copilotFetch = createGithubCopilotFetch({
      githubToken: encodeGithubAppCredential(credential),
    });
    const response = await copilotFetch(
      "https://api.githubcopilot.com/chat/completions",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
