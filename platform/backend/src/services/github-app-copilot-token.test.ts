import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decodeGithubAppCredential,
  encodeGithubAppCredential,
  type GithubAppCredential,
  githubAppKeyFingerprint,
  githubAppOrganization,
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

describe("GitHub App credential marker", () => {
  test("round-trips with the GitHub address and organization", () => {
    const credential = uniqueCredential();
    const encoded = encodeGithubAppCredential(credential);

    expect(encoded.startsWith("github-app:")).toBe(true);
    expect(encoded).not.toContain("BEGIN");
    expect(decodeGithubAppCredential(encoded)).toEqual(credential);
  });

  test("still decodes a preview key without address or organization", () => {
    const legacy = `github-app:${Buffer.from(
      JSON.stringify({ appId: "1", installationId: "2", privateKey }),
    ).toString("base64url")}`;

    expect(decodeGithubAppCredential(legacy)).toEqual({
      appId: "1",
      installationId: "2",
      privateKey,
    });
  });

  test("decodes nothing from other credentials or a corrupted payload", () => {
    expect(decodeGithubAppCredential("gho_personal")).toBeNull();
    expect(decodeGithubAppCredential("github-app:not-json")).toBeNull();
  });
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

describe("githubAppOrganization", () => {
  test("looks up a preview key's organization from its installation", async () => {
    const credential = uniqueCredential({ organization: undefined });
    const fetchMock = vi.fn(async (_input: unknown) =>
      Response.json({ account: { login: "my-org" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await githubAppOrganization(credential)).toBe("my-org");
    expect(await githubAppOrganization(credential)).toBe("my-org");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.github.com/app/installations/${credential.installationId}`,
    );
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
      githubToken: encodeGithubAppCredential(credential),
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
      githubToken: encodeGithubAppCredential(credential),
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
      githubToken: encodeGithubAppCredential(credential),
    })("https://api.githubcopilot.com/models");
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(401);
    expect(body.error.message).toContain(
      "my-org doesn't allow Copilot requests from GitHub Apps",
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
      githubToken: encodeGithubAppCredential(credential),
    })("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("messages must be non-empty");
  });
});
