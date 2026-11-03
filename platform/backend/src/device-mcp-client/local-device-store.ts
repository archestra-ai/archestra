import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LocalDeviceAccessError,
  type LocalDeviceClient,
  type LocalDeviceCredential,
  LocalDeviceCredentialSchema,
} from "./local-device-client";

export type DeviceEncryption = {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
};

/** Credentials remain encrypted by the signed-in user's OS vault on disk. */
export class LocalDeviceStore {
  constructor(
    private readonly path: string,
    private readonly encryption: DeviceEncryption,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}
  async assertAvailable() {
    if (
      !["darwin", "win32"].includes(this.platform) ||
      !(await this.encryption.isAvailable())
    )
      throw new Error(
        "Secure device storage is unavailable. Unlock your computer's credential store and try again.",
      );
  }
  async save(credential: LocalDeviceCredential) {
    await this.assertAvailable();
    const value = await this.encryption.encrypt(
      JSON.stringify(LocalDeviceCredentialSchema.parse(credential)),
    );
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async load(): Promise<LocalDeviceCredential | undefined> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      if ((await handle.stat()).size > 16 * 1024)
        throw new Error(
          "Saved device connection is invalid. Remove it and add this computer again.",
        );
      await this.assertAvailable();
      const data = await this.encryption.decrypt(await handle.readFile());
      return LocalDeviceCredentialSchema.parse(JSON.parse(data));
    } finally {
      await handle.close();
    }
  }
  async clear() {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Permanent authorization loss removes the saved proof before the UI offers setup again. */
export async function runStoredLocalDevice(
  store: LocalDeviceStore,
  client: LocalDeviceClient,
  credential: LocalDeviceCredential,
  report: (state: "online" | "connecting", name: string) => void,
  signal: AbortSignal,
) {
  try {
    await client.run(credential, report, signal);
  } catch (error) {
    if (
      error instanceof LocalDeviceAccessError &&
      error.credentialInvalid &&
      !signal.aborted
    )
      await store.clear();
    throw error;
  }
}
