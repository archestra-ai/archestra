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
  test("exchanges app credentials for an installation token", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ token: "installation-token" }), {
        status: 200,
      });
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
      return new Response(JSON.stringify({ token: "cached-token" }), {
        status: 200,
      });
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
});
