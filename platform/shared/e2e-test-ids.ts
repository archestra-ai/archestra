export const E2eTestId = {
  AgentsTable: "agents-table",
  CreateAgentButton: "create-agent-button",
  CreateAgentCloseHowToConnectButton: "create-agent-how-to-connect-button",
  DeleteAgentButton: "delete-agent-button",
  OnboardingNextButton: "onboarding-next-button",
  OnboardingFinishButton: "onboarding-finish-button",
  OnboardingSkipButton: "onboarding-skip-button",
  InviteMemberButton: "invite-member-button",
  InviteEmailInput: "invite-email-input",
  InviteRoleSelect: "invite-role-select",
  GenerateInvitationButton: "generate-invitation-button",
  InvitationLinkInput: "invitation-link-input",
  InvitationLinkCopyButton: "invitation-link-copy-button",
  InvitationErrorMessage: "invitation-error-message",
  SidebarUserProfile: "sidebar-user-profile",
  SidebarNavGuardrails: "sidebar-nav-tool-policies",
  ManageCredentialsDialog: "manage-credentials-dialog",
  ManageCredentialsDialogTable: "manage-credentials-dialog-table",
  CredentialRow: "credential-row",
  CredentialOwner: "credential-owner",
  CredentialTeamSelect: "credential-team-select",
  ManageCredentialsButton: "manage-credentials-button",
  ManageToolsButton: "manage-tools-button",
  ConfigureIdpTeamSyncButton: "configure-idp-team-sync-button",
  IdentityProviderCard: "identity-provider-card",
  IdentityProviderOpenDialogButton: "identity-provider-open-dialog-button",
  IdentityProviderCreateButton: "identity-provider-create-button",
  IdentityProviderUpdateButton: "identity-provider-update-button",
  IdentityProviderDeleteButton: "identity-provider-delete-button",
  IdpRoleMappingAccordionTrigger: "idp-role-mapping-accordion-trigger",
  IdpRoleMappingDefaultRole: "idp-role-mapping-default-role",
  IdpRoleMappingRuleRole: "idp-role-mapping-rule-role",
  IdpRoleMappingRuleTemplate: "idp-role-mapping-rule-template",
  IdpRoleMappingAddRule: "idp-role-mapping-add-rule",
  McpServerError: "mcp-server-error",
  McpServerCard: "mcp-server-card",
  McpServerToolsCount: "mcp-server-tools-count",
  McpToolsDialog: "mcp-tools-dialog",
  TokenSelect: "token-select",
  ProfileTokenManagerTeamsSelect: "profile-token-manager-teams-select",
  ConnectAgentButton: "connect-agent-button",
  ConnectCatalogItemButton: "connect-catalog-item-button",
  SelectCredentialTypePersonal: "select-credential-type-personal",
  CredentialsCount: "credentials-count",
  StaticCredentialToUse: "static-credential-to-use",
  SelectCredentialTypeTeamDropdown: "select-credential-type-team-dropdown",
  ProfileTeamBadge: "profile-team-badge",
  EditAgentButton: "edit-agent-button",
  RemoveTeamBadge: "remove-team-badge",
  PromptOnInstallationCheckbox: "prompt-on-installation-checkbox",
  RevokeCredentialButton: "revoke-credential-button",
  ExternalSecretSelector: "external-secret-selector",
  SelectEnvironmentVariableType: "select-environment-variable-type",
  AddCatalogItemButton: "add-catalog-item-button",
  ConfigureVaultFolderButton: "configure-vault-folder-button",
  ExternalSecretSelectorTeamTrigger: "external-secret-selector-team-trigger",
  ExternalSecretSelectorSecretTrigger:
    "external-secret-selector-secret-trigger",
  ExternalSecretSelectorSecretTriggerKey:
    "external-secret-selector-secret-trigger-key",
  InlineVaultSecretSelectorSecretTrigger:
    "inline-vault-secret-selector-secret-trigger",
  InlineVaultSecretSelectorSecretTriggerKey:
    "inline-vault-secret-selector-secret-trigger-key",
  ManageMembersButton: "manage-members-button",
  // Chat Settings
  ChatApiKeysTable: "chat-api-keys-table",
  AddChatApiKeyButton: "add-chat-api-key-button",
  ChatApiKeyRow: "chat-api-key-row",
  ChatApiKeyForm: "chat-api-key-form",
  EditChatApiKeyButton: "edit-chat-api-key-button",
  DeleteChatApiKeyButton: "delete-chat-api-key-button",
  SetDefaultChatApiKeyButton: "set-default-chat-api-key-button",
  ManageProfilesChatApiKeyButton: "manage-profiles-chat-api-key-button",
  ChatApiKeyDefaultBadge: "chat-api-key-default-badge",
  BulkAssignChatApiKeysButton: "bulk-assign-chat-api-keys-button",
  BulkAssignChatApiKeysDialog: "bulk-assign-chat-api-keys-dialog",
  VirtualKeysPage: "virtual-keys-page",
  VirtualKeysTable: "virtual-keys-table",
  AddVirtualKeyButton: "add-virtual-key-button",
  VirtualKeyCreateDialog: "virtual-key-create-dialog",
  VirtualKeyDeleteDialog: "virtual-key-delete-dialog",
  VirtualKeyParentKeySelect: "virtual-key-parent-key-select",
  VirtualKeyValue: "virtual-key-value",
  // Chat Prompt Input
  ChatFileUploadButton: "chat-file-upload-button",
  ChatDisabledFileUploadButton: "chat-disabled-file-upload-button",
  ChatApiKeySelectorTrigger: "chat-api-key-selector-trigger",
  ChatApiKeySelectorSearchInput: "chat-api-key-selector-search-input",
  // Chat Model Selector
  ChatModelSelectorTrigger: "chat-model-selector-trigger",
  ChatPromptTextarea: "chat-prompt-textarea",
  QuickstartAddApiKeyButton: "quickstart-add-api-key-button",
  // MCP Logs
  McpLogsDialog: "mcp-logs-dialog",
  McpLogsContent: "mcp-logs-content",
  McpLogsError: "mcp-logs-error",
  McpLogsViewButton: "mcp-logs-view-button",
  McpLogsEditConfigButton: "mcp-logs-edit-config-button",
  McpLogsTab: "mcp-logs-tab",
} as const;

export type E2eTestId = (typeof E2eTestId)[keyof typeof E2eTestId];

export function getIdpRoleMappingRuleRowTestId(index: number): string {
  return `role-mapping-rule-${index}`;
}

export function getChatApiKeySelectorProviderGroupTestId(
  provider: string,
): string {
  return `chat-api-key-selector-provider-${provider}`;
}

export function getChatApiKeySelectorOptionTestId(keyId: string): string {
  return `chat-api-key-selector-option-${keyId}`;
}

export function getVirtualKeyRowTestId(keyName: string): string {
  return `virtual-key-row-${keyName}`;
}

export function getDeleteVirtualKeyButtonTestId(keyName: string): string {
  return `delete-virtual-key-button-${keyName}`;
}
