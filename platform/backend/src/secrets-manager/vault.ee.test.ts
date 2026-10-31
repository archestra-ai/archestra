// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test, vi } from "vitest";
import { withDbTransaction } from "@/database";
import SecretModel from "@/models/secret";
import type { VaultConfig } from "@/types";
import VaultSecretManager from "./vault.ee";

const vaultConfig: VaultConfig = {
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

/** Keeps Vault values in memory and records row locks and Vault writes in order. */
class InMemoryVaultSecretManager extends VaultSecretManager {
  values = new Map<string, string>();
  events: string[] = [];

  protected override async readFromPath(path: string) {
    const value = this.values.get(path);
    if (value === undefined) {
      throw Object.assign(new Error("not found"), {
        response: { statusCode: 404 },
      });
    }
    return { data: { data: { value } } };
  }

  protected override async writeToPath(
    path: string,
    payload: Record<string, unknown>,
  ) {
    this.events.push("vault write");
    this.values.set(path, (payload.data as { value: string }).value);
  }
}

describe("VaultSecretManager transactions", () => {
  test("reads and writes the metadata row through the caller's transaction", async () => {
    const manager = new InMemoryVaultSecretManager(vaultConfig);
    const row = await SecretModel.create({
      name: "vault-transaction",
      secret: {},
      isVault: true,
    });
    await manager.updateSecret(row.id, { apiKey: "v1" });
    const lockedReads = vi.spyOn(SecretModel, "findByIdForUpdate");
    const updates = vi.spyOn(SecretModel, "update");
    try {
      await withDbTransaction(async (transaction) => {
        const read = await manager.getSecret(row.id, {
          transaction,
          forUpdate: true,
        });
        expect(read?.secret).toEqual({ apiKey: "v1" });
        const written = await manager.updateSecret(
          row.id,
          { apiKey: "v2" },
          { transaction },
        );
        expect(written?.secret).toEqual({ apiKey: "v2" });
        // Both the locked read and the write's own lock ran on the caller's
        // transaction, as did the metadata update.
        expect(
          lockedReads.mock.calls.map(([id, tx]) => [id, tx === transaction]),
        ).toEqual([
          [row.id, true],
          [row.id, true],
        ]);
        expect(
          updates.mock.calls.map(([, , tx]) => tx === transaction),
        ).toEqual([true]);
      });
    } finally {
      lockedReads.mockRestore();
      updates.mockRestore();
    }
    expect((await manager.getSecret(row.id))?.secret).toEqual({ apiKey: "v2" });
  });

  test("a write without a transaction locks the metadata row before touching Vault", async () => {
    const manager = new InMemoryVaultSecretManager(vaultConfig);
    const row = await SecretModel.create({
      name: "vault-row-lock",
      secret: {},
      isVault: true,
    });
    const lockRow = SecretModel.findByIdForUpdate.bind(SecretModel);
    const lockedReads = vi
      .spyOn(SecretModel, "findByIdForUpdate")
      .mockImplementation(async (id, tx) => {
        manager.events.push("row lock");
        return lockRow(id, tx);
      });
    try {
      await manager.updateSecret(row.id, { apiKey: "v1" });
    } finally {
      lockedReads.mockRestore();
    }
    expect(manager.events).toEqual(["row lock", "vault write"]);
    expect((await manager.getSecret(row.id))?.secret).toEqual({ apiKey: "v1" });
  });
});
