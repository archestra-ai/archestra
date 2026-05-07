import { SecretsManagerType, TimeInMs } from "@shared";
import { LRUCacheManager } from "@/cache-manager";
import SecretModel from "@/models/secret";
import {
  ApiError,
  type ISecretManager,
  type SecretsConnectivityResult,
  type SecretValue,
  type SelectSecret,
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
    return await SecretModel.delete(secid);
  }

  async removeSecret(secid: string): Promise<boolean> {
    return await this.deleteSecret(secid);
  }

  async getSecret(secid: string): Promise<SelectSecret | null> {
    const cachedSecret = this.secretsCache.get(secid);
    if (cachedSecret) {
      return cachedSecret;
    }

    const secret = await SecretModel.findById(secid);
    if (secret) {
      this.secretsCache.set(secid, secret);
    }
    return secret;
  }

  async updateSecret(
    secid: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    const secret = await SecretModel.update(secid, { secret: secretValue });
    if (secret) {
      this.secretsCache.set(secid, secret);
    } else {
      this.secretsCache.delete(secid);
    }
    return secret;
  }

  async checkConnectivity(): Promise<SecretsConnectivityResult> {
    throw new ApiError(
      501,
      "Connectivity check not implemented for database storage",
    );
  }

  getUserVisibleDebugInfo() {
    return {
      type: this.type,
      meta: {},
    };
  }
}
