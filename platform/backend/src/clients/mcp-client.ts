// mcp-client.ts

// ✅ Match real usage across repo
export type TokenAuthContext = {
  tokenId: string;
  teamId: string | null;
  organizationId: string;
  isOrganizationToken: boolean;
  isUserToken: boolean;
  userId: string;
};

// ✅ Proper interface matching repo usage
export interface McpClient {
  readResource: (
    uri: string,
    agentId?: string,
    context?: TokenAuthContext,
  ) => Promise<any>;

  findToolByName: (name: string, agentId?: string) => Promise<any>;

  callTool: (name: string, args: any, agentId?: string) => Promise<any>;

  // ✅ FIXED SIGNATURE (this removes MANY errors)
  executeToolCall: (
    toolCall: any,
    agentId: string,
    context?: TokenAuthContext,
    options?: any,
  ) => Promise<any>;

  // ✅ FIXED (accept multiple args)
  closeSession: (
    sessionId: string,
    agentId?: string,
    isolationKey?: string,
    context?: TokenAuthContext,
  ) => Promise<void>;

  connectAndGetTools: (params: any) => Promise<any[]>;

  inspectServer: (params: any) => Promise<any>;
}

// ✅ Implementation (safe stubs)
export const mcpClient: McpClient = {
  async readResource() {
    throw new Error("readResource not implemented");
  },

  async findToolByName() {
    return null;
  },

  async callTool() {
    throw new Error("callTool not implemented");
  },

  async executeToolCall() {
    throw new Error("executeToolCall not implemented");
  },

  async closeSession() {
    // no-op
  },

  async connectAndGetTools() {
    return [];
  },

  async inspectServer() {
    return {};
  },
};

// ✅ CRITICAL: keep default export
export default mcpClient;
