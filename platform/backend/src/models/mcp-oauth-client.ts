import {
  A2A_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
} from "@archestra/shared/oauth";
import ManagedOauthClientModel from "./managed-oauth-client";

/** Compatibility facade for the former MCP/A2A management API. */
class McpOauthClientModel {
  static create(params: Parameters<typeof ManagedOauthClientModel.create>[0]) {
    return ManagedOauthClientModel.create({
      ...params,
      scopes: [MCP_GATEWAY_OAUTH_SCOPE, A2A_OAUTH_SCOPE],
      legacyKind: "mcp",
    });
  }
  static findAllByOrganization(
    params: Parameters<typeof ManagedOauthClientModel.findAllByOrganization>[0],
  ) {
    return ManagedOauthClientModel.findAllByOrganization({
      ...params,
      capabilities: [MCP_GATEWAY_OAUTH_SCOPE, A2A_OAUTH_SCOPE],
    });
  }
  static async findByClientId(clientId: string) {
    const client = await ManagedOauthClientModel.findByClientId(clientId);
    return client &&
      !client.disabled &&
      client.scopes.some(
        (scope) =>
          scope === MCP_GATEWAY_OAUTH_SCOPE || scope === A2A_OAUTH_SCOPE,
      )
      ? client
      : null;
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
  static findPageByOrganization(
    ...params: Parameters<typeof ManagedOauthClientModel.findPageByOrganization>
  ) {
    return ManagedOauthClientModel.findPageByOrganization(...params);
  }
  static findByIdForAudit(id: string, organizationId: string) {
    return ManagedOauthClientModel.findByIdForAudit(id, organizationId);
  }
}
export default McpOauthClientModel;
