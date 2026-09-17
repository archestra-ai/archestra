import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { resolveInstallationToken } from "./app-auth";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// distinct installation per test so the module-level token cache never bleeds
function makeCredentials(installationId: string) {
  return {
    githubUrl: "https://api.github.com",
    appId: "12345",
    installationId,
    privateKey,
  };
}

describe("resolveInstallationToken", () => {
  test("uses the signing key from an App connection that also supports user sign-in", async () => {
    const token = await resolveInstallationToken(
      {
        ...makeCredentials("combined-secrets"),
        privateKey: JSON.stringify({
          privateKey,
          clientSecret: "oauth-secret",
        }),
      },
      async (_url, init) => {
        expect(JSON.stringify(init)).not.toContain("oauth-secret");
        return new Response(
          JSON.stringify({
            token: "bot-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      },
    );
    expect(token).toBe("bot-token");
  });

  test("exchanges app credentials for an installation token", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        {
          status: 200,
        },
      );
    }) as typeof fetch;

    const token = await resolveInstallationToken(
      makeCredentials("1001"),
      fetchImpl,
    );

    expect(token).toBe("installation-token");
    expect(calls).toEqual([
      "https://api.github.com/app/installations/1001/access_tokens",
    ]);
  });

  test("caches the token across calls for the same installation", async () => {
    let hits = 0;
    const fetchImpl = (async () => {
      hits += 1;
      return new Response(
        JSON.stringify({
          token: "cached-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        {
          status: 200,
        },
      );
    }) as typeof fetch;

    const first = await resolveInstallationToken(
      makeCredentials("1002"),
      fetchImpl,
    );
    const second = await resolveInstallationToken(
      makeCredentials("1002"),
      fetchImpl,
    );

    expect(first).toBe("cached-token");
    expect(second).toBe("cached-token");
    expect(hits).toBe(1);
  });

  test("surfaces the GitHub error message on failure", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        statusText: "Unauthorized",
      })) as typeof fetch;

    await expect(
      resolveInstallationToken(makeCredentials("1003"), fetchImpl),
    ).rejects.toThrow("Bad credentials");
  });

  test("reports a missing installation as a configuration error and allows retry", async () => {
    const credentials = makeCredentials("missing-installation");
    await expect(
      resolveInstallationToken(
        credentials,
        async () =>
          new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
          }),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Check the app ID, installation ID"),
    });

    await expect(
      resolveInstallationToken(
        credentials,
        async () =>
          new Response(
            JSON.stringify({
              token: "retry-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          ),
      ),
    ).resolves.toBe("retry-token");
  });

  test("does not classify an upstream outage as invalid configuration", async () => {
    await expect(
      resolveInstallationToken(
        makeCredentials("upstream-outage"),
        async () =>
          new Response(JSON.stringify({ message: "Service unavailable" }), {
            status: 503,
            statusText: "Service Unavailable",
          }),
      ),
    ).rejects.toThrow("503 Service Unavailable: Service unavailable");
  });

  test("rejects when required credentials are missing", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as typeof fetch;

    await expect(
      resolveInstallationToken(
        { ...makeCredentials("1004"), privateKey: "" },
        fetchImpl,
      ),
    ).rejects.toThrow("requires app ID, installation ID, and private key");
  });
  test("refreshes a cached installation token before the required lifetime", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          token: `token-${calls}`,
          expires_at: new Date(
            Date.now() + (calls === 1 ? 10 : 60) * 60_000,
          ).toISOString(),
        }),
      );
    }) as typeof fetch;
    const credentials = makeCredentials("expiry-test");
    expect(await resolveInstallationToken(credentials, fetchImpl)).toBe(
      "token-1",
    );
    expect(
      await resolveInstallationToken(
        { ...credentials, minimumValidityMs: 50 * 60_000 },
        fetchImpl,
      ),
    ).toBe("token-2");
    expect(calls).toBe(2);
  });

  test("private key rotation invalidates the cached installation token", async () => {
    let calls = 0;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          token: `token-${++calls}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      )) as typeof fetch;
    const credentials = makeCredentials("rotation-test");
    expect(await resolveInstallationToken(credentials, fetchImpl)).toBe(
      "token-1",
    );
    const rotated = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(
      await resolveInstallationToken(
        { ...credentials, privateKey: rotated.privateKey },
        fetchImpl,
      ),
    ).toBe("token-2");
  });
});

test("refuses installation tokens without a trustworthy future expiry", async () => {
  for (const expires_at of [
    undefined,
    "not-a-date",
    new Date(Date.now() - 1).toISOString(),
  ]) {
    await expect(
      resolveInstallationToken(
        makeCredentials(`invalid-${String(expires_at)}`),
        async () =>
          new Response(JSON.stringify({ token: "unusable-token", expires_at })),
      ),
    ).rejects.toThrow("invalid or expired lifetime");
  }
});
