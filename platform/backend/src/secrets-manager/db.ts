import { SecretsManagerType, TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import SecretModel from "@/models/secret";
import type {
  ISecretManager,
  SecretsConnectivityResult,
  SecretValue,
  SelectSecret,
} from "@/types";

/**
 * Database-backed implementation of SecretManager
 * Stores secrets in the database using SecretModel
 */
export class DbSecretsManager implements ISecretManager {
  readonly type = SecretsManagerType.DB;
  private readonly secretsCache = new LRUCacheManager<SelectSecret>({
    maxSize: 2_000,
    defaultTtl: 5 * TimeInMs.Minute,
  });
  private readonly pendingReads = new LRUCacheManager<
    Promise<SelectSecret | null>
  >({
    maxSize: 2_000,
    defaultTtl: 0,
  });

  async createSecret(
    secretValue: SecretValue,
    name: string,
    _forceDB?: boolean,
  ): Promise<SelectSecret> {
    // forceDB is ignored for DbSecretsManager since it always uses DB
    const secret = await SecretModel.create({
      name,
      secret: secretValue,
    });
    this.secretsCache.set(secret.id, secret);
    return secret;
  }

  async deleteSecret(secid: string): Promise<boolean> {
    this.secretsCache.delete(secid);
    this.pendingReads.delete(secid);
    const deleted = await SecretModel.delete(secid);
    this.pendingReads.delete(secid);
    this.secretsCache.delete(secid);
    return deleted;
  }

  async removeSecret(secid: string): Promise<boolean> {
    return await this.deleteSecret(secid);
  }

  /**
   * The cache is process-local and refreshed only on the replica that handled
   * the write, so a rotation elsewhere stays invisible here for up to its TTL.
   * `skipCache` is for callers that cannot tolerate that window; the fresh row
   * still populates the cache, so the refresh benefits every later reader.
   */
  async getSecret(
    secid: string,
    options?: { skipCache?: boolean },
  ): Promise<SelectSecret | null> {
    if (!options?.skipCache) {
      const cachedSecret = this.secretsCache.get(secid);
      if (cachedSecret) {
        return cachedSecret;
      }
      const pending = this.pendingReads.get(secid);
      if (pending) return pending;
    }

    // Fresh reads always start a new query. Only the newest read may populate
    // the cache, so an older miss cannot overwrite a rotation or deletion.
    const read = SecretModel.findById(secid);
    this.pendingReads.set(secid, read);
    try {
      const secret = await read;
      if (this.pendingReads.get(secid) === read) {
        if (secret) this.secretsCache.set(secid, secret);
        else this.secretsCache.delete(secid);
      }
      return secret;
    } finally {
      if (this.pendingReads.get(secid) === read)
        this.pendingReads.delete(secid);
    }
  }

  async updateSecret(
    secid: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    const secret = await SecretModel.update(secid, { secret: secretValue });
    this.pendingReads.delete(secid);
    if (secret) {
      this.secretsCache.set(secid, secret);
    } else {
      this.secretsCache.delete(secid);
    }
    return secret;
  }

  async checkConnectivity(): Promise<SecretsConnectivityResult> {
    return { secretCount: await SecretModel.count() };
  }

  getUserVisibleDebugInfo() {
    return {
      type: this.type,
      meta: {},
    };
  }
}
