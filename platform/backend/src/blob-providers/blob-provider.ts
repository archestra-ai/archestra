import { randomUUID } from "node:crypto";

/**
 * A configured object storage destination that features write files to.
 *
 * Each provider type implements {@link putObject} and {@link deleteObject};
 * everything else (key layout, connection tests) is shared here, so a new
 * provider type is one small subclass plus a registry entry
 * (`./registry.ts`). Keys passed in are relative: the provider adds its own
 * configured prefix.
 */
export abstract class BlobProvider {
  constructor(protected readonly keyPrefix: string) {}

  /** Write (or overwrite) one object; returns its full key and a URI for it. */
  async put(params: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<{ key: string; location: string }> {
    const key = this.fullKey(params.key);
    await this.putObject({ ...params, key });
    return { key, location: this.locationOf(key) };
  }

  /**
   * Prove the configuration works the way features use it: write a small
   * object under the provider's prefix and delete it again.
   */
  async testConnection(): Promise<void> {
    const key = this.fullKey(`.archestra-connection-test/${randomUUID()}.txt`);
    await this.putObject({
      key,
      body: "Archestra blob provider connection test. Safe to delete.\n",
      contentType: "text/plain",
    });
    await this.deleteObject(key);
  }

  /** Write one object at a full key (prefix already applied). */
  protected abstract putObject(params: {
    key: string;
    body: Buffer | string;
    contentType: string;
  }): Promise<void>;

  /** Delete one object at a full key (prefix already applied). */
  protected abstract deleteObject(key: string): Promise<void>;

  /** A human-readable URI of an object, e.g. `s3://bucket/key`. */
  protected abstract locationOf(key: string): string;

  // === internal ===

  private fullKey(key: string): string {
    const relative = key.replace(/^\/+/, "");
    return this.keyPrefix ? `${this.keyPrefix}/${relative}` : relative;
  }
}

/** A provider SDK error as one line an admin can act on. */
export function describeBlobProviderError(error: unknown): string {
  if (error instanceof Error) {
    const e = error as Error & {
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const code = e.Code ?? e.name;
    const status = e.$metadata?.httpStatusCode;
    const prefix = [code, status ? `HTTP ${status}` : null]
      .filter(Boolean)
      .join(", ");
    return prefix && !e.message.startsWith(code)
      ? `${prefix}: ${e.message}`
      : e.message;
  }
  return String(error);
}
