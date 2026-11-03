import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  LocalDeviceClient,
  type LocalDeviceCredential,
} from "./local-device-client";
import {
  type DeviceEncryption,
  LocalDeviceStore,
  runStoredLocalDevice,
} from "./local-device-store";

const credential: LocalDeviceCredential = {
  version: 1,
  deviceId: "00000000-0000-4000-8000-000000000001",
  token: "device-secret-token",
  name: "Computer",
  url: "https://deployment.example",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
// A deterministic OS-vault test boundary. Production receives Electron safeStorage, not this adapter.
const vault: DeviceEncryption = {
  isAvailable: async () => true,
  encrypt: async (value) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)),
  decrypt: async (value) =>
    Buffer.from(value.map((byte) => byte ^ 0xa5)).toString(),
};

describe("local device encrypted credential store", () => {
  test("persists ciphertext and reconnect metadata, then removes it on revocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-device-store-"));
    try {
      const path = join(dir, "connection.enc");
      const store = new LocalDeviceStore(path, vault, "darwin");
      expect(await store.load()).toBeUndefined();
      await store.save(credential);
      expect((await readFile(path)).includes(credential.token)).toBe(false);
      expect(await new LocalDeviceStore(path, vault, "darwin").load()).toEqual(
        credential,
      );
      await store.clear();
      expect(await store.load()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test.each([
    401, 409,
  ])("revocation removes the credential while a stale session preserves it (%s)", async (status) => {
    const dir = await mkdtemp(join(tmpdir(), "local-device-store-"));
    try {
      const store = new LocalDeviceStore(
        join(dir, "connection.enc"),
        vault,
        "darwin",
      );
      await store.save(credential);
      const client = new LocalDeviceClient(
        credential.url,
        async () => new Response("{}", { status }),
      );
      await expect(
        runStoredLocalDevice(
          store,
          client,
          credential,
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(await store.load()).toEqual(
        status === 401 ? undefined : credential,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("fails closed without an OS vault or on an unsupported platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-device-store-"));
    try {
      const unavailable = new LocalDeviceStore(
        join(dir, "none"),
        { ...vault, isAvailable: async () => false },
        "win32",
      );
      await expect(unavailable.save(credential)).rejects.toThrow(
        "Secure device storage",
      );
      await expect(
        new LocalDeviceStore(join(dir, "linux"), vault, "linux").save(
          credential,
        ),
      ).rejects.toThrow("Secure device storage");
      expect(await unavailable.load()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("rejects corrupted or substituted connection files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-device-store-"));
    try {
      const target = join(dir, "target");
      const link = join(dir, "connection.enc");
      await writeFile(target, "plaintext token");
      await symlink(target, link);
      await expect(
        new LocalDeviceStore(link, vault, "darwin").load(),
      ).rejects.toThrow();
      await rm(link);
      await writeFile(link, Buffer.alloc(17 * 1024));
      await expect(
        new LocalDeviceStore(link, vault, "darwin").load(),
      ).rejects.toThrow("invalid");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
