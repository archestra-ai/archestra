import { LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared/oauth";
import ManagedOauthClientModel from "./managed-oauth-client";

/** Compatibility facade for the former LLM-specific management API. */
class LlmOauthClientModel {
  static create(params: Parameters<typeof ManagedOauthClientModel.create>[0]) {
    return ManagedOauthClientModel.create({
      ...params,
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      legacyKind: "llm",
    });
  }
  static findAllByOrganization(
    params: Parameters<typeof ManagedOauthClientModel.findAllByOrganization>[0],
  ) {
    return ManagedOauthClientModel.findAllByOrganization({
      ...params,
      capabilities: [LLM_PROXY_OAUTH_SCOPE],
    });
  }
  static findPageByOrganization(
    params: Parameters<
      typeof ManagedOauthClientModel.findPageByOrganization
    >[0],
  ) {
    return ManagedOauthClientModel.findPageByOrganization({
      ...params,
      capabilities: [LLM_PROXY_OAUTH_SCOPE],
    });
  }
  static async findByClientId(clientId: string) {
    const client = await ManagedOauthClientModel.findByClientId(clientId);
    return client?.scopes.includes(LLM_PROXY_OAUTH_SCOPE) ? client : null;
  }
  static findByIds(
    ...params: Parameters<typeof ManagedOauthClientModel.findByIds>
  ) {
    return ManagedOauthClientModel.findByIds(...params);
  }
  static findById(
    ...params: Parameters<typeof ManagedOauthClientModel.findById>
  ) {
    return ManagedOauthClientModel.findById(...params);
  }
  static findByProviderApiKeyId(
    ...params: Parameters<typeof ManagedOauthClientModel.findByProviderApiKeyId>
  ) {
    return ManagedOauthClientModel.findByProviderApiKeyId(...params);
  }
  static findClientForCredentials(
    ...params: Parameters<
      typeof ManagedOauthClientModel.findClientForCredentials
    >
  ) {
    return ManagedOauthClientModel.findClientForCredentials(...params);
  }
  static rotateSecret(
    ...params: Parameters<typeof ManagedOauthClientModel.rotateSecret>
  ) {
    return ManagedOauthClientModel.rotateSecret(...params);
  }
  static update(...params: Parameters<typeof ManagedOauthClientModel.update>) {
    return ManagedOauthClientModel.update(...params);
  }
  static delete(...params: Parameters<typeof ManagedOauthClientModel.delete>) {
    return ManagedOauthClientModel.delete(...params);
  }
  static findByIdForAudit(id: string, organizationId: string) {
    return ManagedOauthClientModel.findByIdForAudit(id, organizationId);
  }
}
export default LlmOauthClientModel;
