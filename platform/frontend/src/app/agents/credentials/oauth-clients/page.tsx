// The OAuth clients management UI is shared with the MCP gateways credentials
// section — an OAuth client's allowed list can include MCP gateways and/or A2A
// agents. Rendering the same page under the agents credentials layout makes it
// discoverable from Agents, where A2A auth is configured. The action-button
// context is provided by this route's layout via the shared
// CredentialsActionContext.
export { default } from "@/app/mcp/credentials/oauth-clients/page";
