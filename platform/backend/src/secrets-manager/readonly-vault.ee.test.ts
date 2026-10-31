// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test, vi } from "vitest";
import { withDbTransaction } from "@/database";
import SecretModel from "@/models/secret";
import type { VaultConfig } from "@/types";
import ReadonlyVaultSecretManager from "./readonly-vault.ee";

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

describe("ReadonlyVaultSecretManager transactions", () => {
  test("reads the metadata row through the caller's transaction and locks it on request", async () => {
    const manager = new ReadonlyVaultSecretManager(vaultConfig);
    const row = await SecretModel.create({
      name: "byos-transaction",
      secret: { apiKey: "stored-in-db" },
    });
    const lockedReads = vi.spyOn(SecretModel, "findByIdForUpdate");
    const plainReads = vi.spyOn(SecretModel, "findById");
    try {
      await withDbTransaction(async (transaction) => {
        const read = await manager.getSecret(row.id, {
          transaction,
          forUpdate: true,
        });
        expect(read?.secret).toEqual({ apiKey: "stored-in-db" });
        expect(
          lockedReads.mock.calls.map(([id, tx]) => [id, tx === transaction]),
        ).toEqual([[row.id, true]]);
        expect(plainReads).not.toHaveBeenCalled();
      });
    } finally {
      lockedReads.mockRestore();
      plainReads.mockRestore();
    }
  });

  test("writes the row through the caller's transaction after a locked read", async () => {
    const manager = new ReadonlyVaultSecretManager(vaultConfig);
    const row = await SecretModel.create({
      name: "byos-transactional-write",
      secret: { apiKey: "before" },
    });
    // A statement outside the transaction would wait on the row lock that
    // transaction holds (on PGlite, which has one connection, it would hang),
    // so the spies refuse it instead of passing it through.
    const realFindById = SecretModel.findById.bind(SecretModel);
    const realUpdate = SecretModel.update.bind(SecretModel);
    const reads = vi
      .spyOn(SecretModel, "findById")
      .mockImplementation(async (id, tx) => {
        if (!tx) throw new Error("read outside the caller's transaction");
        return realFindById(id, tx);
      });
    const writes = vi
      .spyOn(SecretModel, "update")
      .mockImplementation(async (id, input, tx) => {
        if (!tx) throw new Error("write outside the caller's transaction");
        return realUpdate(id, input, tx);
      });
    try {
      await withDbTransaction(async (transaction) => {
        await manager.getSecret(row.id, { transaction, forUpdate: true });
        const written = await manager.updateSecret(
          row.id,
          { apiKey: "after" },
          { transaction },
        );
        expect(written?.secret).toEqual({ apiKey: "after" });
        expect(writes.mock.calls.map(([, , tx]) => tx === transaction)).toEqual(
          [true],
        );
      });
    } finally {
      reads.mockRestore();
      writes.mockRestore();
    }
    expect((await SecretModel.findById(row.id))?.secret).toEqual({
      apiKey: "after",
    });
  });
});
