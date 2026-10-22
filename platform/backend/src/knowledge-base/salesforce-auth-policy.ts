/** Admission policy shared by the REST and MCP connector entry points. */
export function salesforceAuthPolicyViolation({
  connectorType,
  nextConfig,
  existingConfig,
  hasNewSecret = false,
}: {
  connectorType: string;
  nextConfig?: Record<string, unknown>;
  existingConfig?: Record<string, unknown>;
  hasNewSecret?: boolean;
}): string | undefined {
  if (connectorType !== "salesforce" || !nextConfig) return;
  const nextIsOAuth =
    nextConfig.type === "salesforce" &&
    nextConfig.authMethod === "oauth_client_credentials";
  if (!existingConfig && !nextIsOAuth) {
    return "New Salesforce connectors require OAuth client credentials; username/password is only supported for existing legacy connectors";
  }
  if (
    existingConfig?.authMethod === "oauth_client_credentials" &&
    !nextIsOAuth
  ) {
    return "Salesforce OAuth connectors cannot switch back to deprecated username/password authentication";
  }
  if (nextConfig.type !== "salesforce") {
    return "Salesforce connectors require Salesforce configuration";
  }
  if (
    existingConfig &&
    existingConfig.authMethod !== "oauth_client_credentials" &&
    nextIsOAuth &&
    !hasNewSecret
  ) {
    return "Salesforce OAuth migration requires a new consumer secret; the stored password cannot be reused. Migrate in the connector edit dialog or through the REST API with new credentials";
  }
}
