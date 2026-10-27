import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createGithubAppJwt,
  decodeGithubAppCredential,
  encodeGithubAppCredential,
  type GithubAppCredential,
  githubAppCopilotTokenManager,
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

describe("detectGithubAppWireMode", () => {
  test("uses mode A when Copilot accepts the token with editor headers", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi.fn(async (input: unknown) =>
      isMintCall(input) ? mintResponse() : Response.json({ data: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const mode = await detectGithubAppWireMode({ credential });

    expect(mode).toBe("A");
    const [, init] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer ghs_installation");
    expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
  });

  test("falls through to mode B without editor headers", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (isMintCall(input)) return mintResponse();
      const headers = new Headers(init?.headers);
      return headers.has("editor-version")
        ? Response.json({ message: "bad integration" }, { status: 400 })
        : Response.json({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await detectGithubAppWireMode({ credential })).toBe("B");
  });

  test("falls through to mode C through the token exchange", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (isMintCall(url)) return mintResponse();
        if (url.includes("copilot_internal")) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "token ghs_installation",
          );
          return Response.json({
            token: "copilot-bearer",
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          });
        }
        const auth = new Headers(init?.headers).get("authorization");
        return auth === "Bearer copilot-bearer"
          ? Response.json({ data: [] })
          : Response.json({ message: "unauthorized" }, { status: 401 });
      }),
    );

    expect(await detectGithubAppWireMode({ credential })).toBe("C");
  });

  test("lists every attempt when all modes fail", async () => {
    const credential = uniqueCredential();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        // A fresh token, so no earlier test's cached exchange is reused.
        if (isMintCall(url)) return mintResponse("ghs_all_fail");
        if (url.includes("copilot_internal"))
          return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({ message: "bad credentials" }, { status: 401 });
      }),
    );

    await expect(detectGithubAppWireMode({ credential })).rejects.toThrow(
      /A: 401 bad credentials; B: 401 bad credentials; C: .*404/,
    );
  });

  test("stops at a 403 saying App-token requests are not enabled", async () => {
    const credential = uniqueCredential();
    const fetchMock = vi.fn(async (input: unknown) =>
      isMintCall(input)
        ? mintResponse()
        : Response.json(
            {
              message:
                "Copilot requests from GitHub App installations are not enabled for this organization",
            },
            { status: 403 },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(detectGithubAppWireMode({ credential })).rejects.toThrow(
      /^GitHub Copilot did not accept .* A: 403 Copilot requests from GitHub App installations are not enabled/,
    );
    // One mint and one probe: B and C were not tried.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createGithubCopilotFetch with a GitHub App credential", () => {
  test("re-mints and retries once when Copilot answers 401", async () => {
    const credential = uniqueCredential();
    githubAppCopilotTokenManager.setWireMode(credential, "B");
    const mints = ["ghs_first", "ghs_second"];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (isMintCall(input)) return mintResponse(mints.shift());
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer ghs_second"
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
