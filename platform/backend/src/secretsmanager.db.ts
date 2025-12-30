import { SecretsManagerType } from "@shared";
import SecretModel from "./models/secret";
import type {
  ISecretManager,
  SecretsConnectivityResult,
} from "./secretmanager.types";
import { ApiError, type SecretValue, type SelectSecret } from "./types";

/**
 * Database-backed implementation of SecretManager
 * Stores secrets in the database using SecretModel
 */
export class DbSecretsManager implements ISecretManager {
  readonly type = SecretsManagerType.DB;

  async createSecret(
    secretValue: SecretValue,
    name: string,
    _forceDB?: boolean,
  ): Promise<SelectSecret> {
    // forceDB is ignored for DbSecretsManager since it always uses DB
    return await SecretModel.create({
      name,
      secret: secretValue,
    });
  }

  async deleteSecret(secid: string): Promise<boolean> {
    return await SecretModel.delete(secid);
  }

  async removeSecret(secid: string): Promise<boolean> {
    return await this.deleteSecret(secid);
  }

  async getSecret(secid: string): Promise<SelectSecret | null> {
    return await SecretModel.findById(secid);
  }

  async updateSecret(
    secid: string,
    secretValue: SecretValue,
  ): Promise<SelectSecret | null> {
    return await SecretModel.update(secid, { secret: secretValue });
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
