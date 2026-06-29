import { vi } from "vitest";
import SecretModel from "@/models/secret";
import { describe, expect, test } from "@/test";
import { DbSecretsManager } from "./db";

describe("DbSecretsManager", () => {
  test("caches secret lookups and invalidates on update", async ({
    makeSecret,
  }) => {
    const createdSecret = await makeSecret({
      secret: { access_token: "initial-token" },
    });
    const manager = new DbSecretsManager();
    const findByIdSpy = vi.spyOn(SecretModel, "findById");

    const firstSecret = await manager.getSecret(createdSecret.id);
    const secondSecret = await manager.getSecret(createdSecret.id);

    expect(firstSecret?.secret).toEqual({ access_token: "initial-token" });
    expect(secondSecret?.secret).toEqual({ access_token: "initial-token" });
    expect(findByIdSpy).toHaveBeenCalledTimes(1);

    await manager.updateSecret(createdSecret.id, {
      access_token: "updated-token",
    });
    const updatedSecret = await manager.getSecret(createdSecret.id);

    expect(updatedSecret?.secret).toEqual({ access_token: "updated-token" });
    expect(findByIdSpy).toHaveBeenCalledTimes(1);

    findByIdSpy.mockRestore();
  });

  test("invalidates cached secrets on delete", async ({ makeSecret }) => {
    const createdSecret = await makeSecret({
      secret: { access_token: "delete-token" },
    });
    const manager = new DbSecretsManager();
    const findByIdSpy = vi.spyOn(SecretModel, "findById");

    expect(await manager.getSecret(createdSecret.id)).not.toBeNull();
    await manager.deleteSecret(createdSecret.id);
    expect(await manager.getSecret(createdSecret.id)).toBeNull();
    expect(findByIdSpy).toHaveBeenCalledTimes(2);

    findByIdSpy.mockRestore();
  });
});
