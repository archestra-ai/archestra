// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ScopedResource } from "@archestra/shared";
import { scopedResourceNouns } from "@archestra/shared";

type Descriptions = {
  view: string;
  use?: string;
  deploy?: string;
} & ({ edit: string; manage?: string } | { edit?: never; manage: string });

/** Shared by the creation form and the editor for an existing resource. */
export function presetDescription(preset: string, resource: ScopedResource) {
  const descriptions = resourceDescriptions[resource];
  if (preset === "manage") {
    return (
      descriptions.manage ??
      `${descriptions.edit} Delete the ${scopedResourceNouns[resource]} and change who can access it.`
    );
  }
  return descriptions[preset as keyof Descriptions] ?? "";
}

// Describe the operation, not just the action's name. In particular, access to
// a credential's settings is distinct from possession of its bearer token.
const resourceDescriptions: Record<ScopedResource, Descriptions> = {
  agent: {
    view: "View the agent's instructions, tools, and configuration without running it.",
    use: "View and run the agent in chats or delegate tasks to it.",
    edit: "Run the agent and change its instructions, tools, and configuration.",
  },
  mcpGateway: {
    view: "View the gateway's configuration and assigned tools without invoking them.",
    use: "View the gateway and call its assigned MCP tools, subject to their policies.",
    edit: "Use the gateway and change its configuration and tool assignments.",
  },
  mcpRegistry: {
    view: "View the MCP server's catalog details and configuration without calling its tools.",
    use: "View the MCP server and call its tools, subject to their policies.",
    edit: "Use the MCP server and update its catalog configuration. Deployment settings require deployment access.",
    manage:
      "Update or delete the MCP registry entry and manage access. Deployment settings require deployment access.",
    deploy:
      "Full access, plus viewing and changing the server's deployment spec, service account, and secret sources.",
  },
  skill: {
    view: "Read the skill's instructions and files without changing them.",
    use: "Read the skill and make it available to agents. Running its code requires the relevant execution permissions.",
    edit: "Use the skill and edit its instructions and files.",
  },
  app: {
    view: "View the app's details and configuration without running it.",
    use: "View and open the app. Its model and tool calls remain subject to their own permissions and policies.",
    edit: "Use the app and update its content and configuration.",
  },
  llmModel: {
    view: "View the model's details and pricing without making inference requests.",
    use: "View the model and send inference requests with an authorized provider credential.",
    edit: "Use the model and update its settings and pricing.",
  },
  project: {
    view: "View the project and its context. Linked resources retain their own permissions.",
    use: "View and use the project's context. This does not grant access to its linked agents or apps.",
    edit: "Use the project and update its details and context. Linked resources retain their own permissions.",
  },
  conversation: {
    view: "Read the chat session and its messages without changing access.",
    manage:
      "Read the chat session and change who can access it. This does not grant access to its agent.",
  },
  agentRun: {
    view: "View the runtime session and its transcript without changing access.",
    manage:
      "View the runtime session and change who can access it. This does not grant access to its agent.",
  },
  plugin: {
    view: "View the plugin's details and included resources without changing them.",
    use: "View and use the plugin's included resources where permitted. Their own permissions still apply.",
    edit: "Use the plugin and update its details and configuration.",
  },
  knowledgeBase: {
    view: "View the knowledge base and its configuration without changing it.",
    use: "View and search the knowledge base for use in agent answers. Source access rules still apply.",
    edit: "Use the knowledge base and update its configuration and sources.",
  },
  knowledgeConnector: {
    view: "View the connector's configuration and sync status without changing them.",
    use: "Use the connector as a knowledge source. Source access rules still apply.",
    edit: "Use the connector and update its configuration and sync settings.",
  },
  knowledgeFile: {
    view: "View the file's details and content without changing it.",
    use: "Read the file and use its content as a knowledge source for agents.",
    edit: "Use the file and update its details and content.",
  },
  llmVirtualKey: {
    view: "View the virtual key's settings and provider mappings. The token value is not revealed.",
    use: "View the key's settings. API requests authenticate with the token; this grant does not reveal it or identify who holds a copy.",
    edit: "Update the key's settings, provider mappings, and expiration. Revealing its token remains restricted to its author.",
    manage:
      "Update or delete the virtual key and manage access to its settings. Token reveal remains author-only; anyone holding the token can send requests.",
  },
  llmProviderApiKey: {
    view: "View the provider key's name and connection settings. The underlying provider secret is not revealed.",
    use: "Send model requests through this provider key and select it for agents or virtual keys. The provider secret is not revealed.",
    edit: "Use the provider key and update its connection settings or replace its secret.",
  },
  externalAgent: {
    view: "View the external agent's connection details without calling it.",
    use: "View and call the external agent, including delegating tasks to it.",
    edit: "Use the external agent and update its connection details.",
  },
  oauthClient: oauthClientDescriptions(),
  mcpOauthClient: oauthClientDescriptions(),
  llmOauthClient: oauthClientDescriptions(),
  environment: {
    view: "View the environment's configuration and network policies without deploying into it.",
    use: "View the environment and deploy agents or MCP servers into it, subject to its network policies.",
    edit: "Use the environment and update its configuration and network policies.",
  },
  serviceAccount: {
    view: "View the service account's details, permissions, and token metadata. Existing token values are not revealed.",
    use: "View the service account and select it as an integration identity, such as a Jira bot's fallback actor. Existing tokens are not revealed or issued.",
    edit: "Use the service account as an integration identity, update its settings, and create or revoke its tokens within your delegation permissions.",
  },
  credential: {
    view: "View the saved credential's details without revealing or binding its secret value.",
    use: "View the credential and connect or bind its value to supported integrations.",
    edit: "Use the credential and update its details or replace its secret value.",
  },
  log: {
    view: "Read LLM and MCP request logs, including stored content where available.",
    manage: "Read LLM and MCP logs and change who can access them.",
  },
  auditLog: {
    view: "Read the audit trail of administrative actions without changing access.",
    manage: "Read audit logs and change who can access them.",
  },
};

function oauthClientDescriptions(): Descriptions {
  return {
    view: "View the OAuth client registration and settings. This does not authorize requests made with its tokens.",
    edit: "Update the OAuth client registration, including rotating its secret. Token access is configured separately.",
    manage:
      "Update or delete the OAuth client registration and manage access to it. Token access is configured separately.",
  };
}
