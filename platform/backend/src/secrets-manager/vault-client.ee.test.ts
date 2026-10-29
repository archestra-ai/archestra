// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import {
  SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
  type VaultConfig,
} from "@/types/secrets-manager";
import { VaultClient } from "./vault-client.ee";

describe("Vault secret reads", () => {
  const server = useMswServer();
  const config: VaultConfig = {
    address: "https://vault.example.test",
    secretPath: "secret/data/test",
    authMethod: "token",
    token: "synthetic-token",
    kvVersion: "2",
    k8sTokenPath: "unused",
    k8sMountPoint: "kubernetes",
    awsMountPoint: "aws",
    awsRegion: "us-east-1",
    awsStsEndpoint: "https://sts.amazonaws.com",
  };
  const path = "secret/data/missing";
  const url = `${config.address}/v1/${path}`;

  test("a missing secret is a 404, not a secrets backend outage", async () => {
    server.use(
      http.get(url, () => HttpResponse.json({ errors: [] }, { status: 404 })),
    );
    await expect(
      new VaultClient(config).getSecretFromPath(path),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: "Vault secret not found. Check the selected secret path.",
      internalCode: undefined,
    });
  });

  test("a missing secret does not trigger Kubernetes reauthentication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vault-read-test-"));
    let logins = 0;
    let reads = 0;
    try {
      const tokenPath = join(directory, "token");
      await writeFile(tokenPath, "synthetic-service-account-token");
      server.use(
        http.post(`${config.address}/v1/auth/kubernetes/login`, () => {
          logins++;
          return HttpResponse.json({
            auth: { client_token: "synthetic-vault-token" },
          });
        }),
        http.get(url, () => {
          reads++;
          return HttpResponse.json({ errors: [] }, { status: 404 });
        }),
      );
      const client = new VaultClient({
        ...config,
        authMethod: "kubernetes",
        k8sRole: "test",
        k8sTokenPath: tokenPath,
      });
      await expect(client.getSecretFromPath(path)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect({ logins, reads }).toEqual({ logins: 1, reads: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a real backend failure remains a 503 outage", async () => {
    server.use(
      http.get(url, () =>
        HttpResponse.json({ errors: ["unavailable"] }, { status: 500 }),
      ),
    );
    await expect(
      new VaultClient(config).getSecretFromPath(path),
    ).rejects.toMatchObject({
      statusCode: 503,
      internalCode: SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
    });
  });

  test("existing secrets still return their values", async () => {
    server.use(
      http.get(url, () =>
        HttpResponse.json({ data: { data: { token: "synthetic-secret" } } }),
      ),
    );
    await expect(
      new VaultClient(config).getSecretFromPath(path),
    ).resolves.toEqual({ token: "synthetic-secret" });
  });
});
