import { randomUUID } from 'crypto';

import ArchestraMcpClient, { type McpTools } from '@backend/archestraMcp';
import { ToolModel } from '@backend/models/tools';
import McpServerSandboxManager from '@backend/sandbox/manager';
import { type AvailableTool } from '@backend/sandbox/schemas';
import log from '@backend/utils/logger';
import WebSocketService from '@backend/websocket';
import { ARCHESTRA_MCP_SERVER_ID, TOOL_ID_SERVER_TOOL_NAME_SEPARATOR, deconstructToolId } from '@constants';

interface ApprovalRequest {
  requestId: string;
  toolId: string;
  toolName: string;
  toolDescription?: string;
  args: Record<string, any>;
  isWrite: boolean;
  sessionId: string;
  chatId: number;
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

interface SessionRule {
  toolId: string;
  decision: 'always_approve' | 'always_decline';
  timestamp: number;
}

/**
 * ToolService is responsible for:
 * - Aggregating tools from sandboxed MCP servers and Archestra MCP server
 * - Managing tool approval workflow for write operations
 * - Handling session-level approval rules
 */
export class ToolService {
  // Store for pending approval requests
  private pendingApprovals = new Map<string, ApprovalRequest>();

  // Store for session-level approval rules
  private sessionApprovalRules = new Map<string, Map<string, 'always_approve' | 'always_decline'>>();

  private readonly APPROVAL_TIMEOUT = 120000; // 2 minutes
  private readonly ARCHESTRA_MCP_PREFIX = `${ARCHESTRA_MCP_SERVER_ID}${TOOL_ID_SERVER_TOOL_NAME_SEPARATOR}`;

  /**
   * Get all tools from all sources in the Vercel AI SDK format
   */
  getAllTools(): McpTools {
    const allTools: McpTools = {};

    // Get tools from sandboxed MCP servers
    const sandboxedTools = McpServerSandboxManager.getAllTools();
    for (const [toolId, tool] of Object.entries(sandboxedTools)) {
      allTools[toolId] = tool;
    }

    // Get tools from Archestra MCP server
    const archestraTools = ArchestraMcpClient.getAllTools();
    for (const [toolId, tool] of Object.entries(archestraTools)) {
      allTools[toolId] = tool;
    }

    return allTools;
  }

  /**
   * Get specific tools by ID from all sources in the Vercel AI SDK format
   */
  getToolsById(toolIds: string[]): McpTools {
    const selected: McpTools = {};

    // Try to get each tool from sandboxed servers first
    const sandboxedTools = McpServerSandboxManager.getToolsById(toolIds);
    for (const [toolId, tool] of Object.entries(sandboxedTools)) {
      selected[toolId] = tool;
    }

    // Then try to get remaining tools from Archestra MCP server
    const remainingIds = toolIds.filter((id) => !selected[id]);
    if (remainingIds.length > 0) {
      const archestraTools = ArchestraMcpClient.getToolsById(remainingIds);
      for (const [toolId, tool] of Object.entries(archestraTools)) {
        selected[toolId] = tool;
      }
    }

    return selected;
  }

  /**
   * Get all available tools from all sources in UI format
   */
  getAllAvailableTools(): AvailableTool[] {
    const allTools: AvailableTool[] = [];

    // Get tools from sandboxed MCP servers
    allTools.push(...McpServerSandboxManager.allAvailableTools);

    // Get tools from Archestra MCP server
    if (ArchestraMcpClient.connected) {
      allTools.push(...ArchestraMcpClient.availableToolsList);
    }

    return allTools;
  }

  /**
   * Helper to create a key for tool-level approval rules
   */
  private createApprovalRuleKey(toolId: string): string {
    return toolId;
  }

  /**
   * Check if a tool needs approval based on its properties
   */
  async needsApproval(toolId: string): Promise<boolean> {
    // Archestra MCP tools are always allowed
    if (toolId.startsWith(this.ARCHESTRA_MCP_PREFIX)) {
      return false;
    }

    // Get tool analysis from database
    const tool = await ToolModel.getById(toolId);
    if (!tool) {
      log.warn(`Tool not found in database: ${toolId}, requiring approval by default`);
      return true; // Require approval for unknown tools
    }

    // Require approval for write tools
    return tool.is_write === true;
  }

  /**
   * Check session rules for a specific tool
   */
  checkSessionRule(
    sessionId: string,
    toolId: string,
    args: Record<string, any>
  ): 'always_approve' | 'always_decline' | null {
    const sessionRules = this.sessionApprovalRules.get(sessionId);
    if (!sessionRules) return null;

    // Check for tool-level rule
    const toolKey = this.createApprovalRuleKey(toolId);
    return sessionRules.get(toolKey) || null;
  }

  /**
   * Add a session rule for future approvals
   */
  addSessionRule(
    sessionId: string,
    toolId: string,
    args: Record<string, any>,
    decision: 'always_approve' | 'always_decline'
  ): void {
    if (!this.sessionApprovalRules.has(sessionId)) {
      this.sessionApprovalRules.set(sessionId, new Map());
    }

    const sessionRules = this.sessionApprovalRules.get(sessionId)!;
    const key = this.createApprovalRuleKey(toolId);
    sessionRules.set(key, decision);

    log.info(`Added session rule for ${sessionId}: ${key} -> ${decision}`);
  }

  /**
   * Request approval for a tool call
   */
  async requestApproval(
    toolId: string,
    toolName: string,
    args: Record<string, any>,
    sessionId: string,
    chatId: number,
    toolDescription?: string
  ): Promise<boolean> {
    // Check if we need approval at all
    const requiresApproval = await this.needsApproval(toolId);
    if (!requiresApproval) {
      return true; // Auto-approve tools that don't need approval
    }

    // Check session rules
    const sessionRule = this.checkSessionRule(sessionId, toolId, args);
    if (sessionRule === 'always_approve') {
      log.info(`Auto-approving tool ${toolId} based on session rule`);
      return true;
    }
    if (sessionRule === 'always_decline') {
      log.info(`Auto-declining tool ${toolId} based on session rule`);
      return false;
    }

    // Generate a unique request ID
    const requestId = randomUUID();

    // Get tool details from database
    const tool = await ToolModel.getById(toolId);
    const isWrite = tool?.is_write === true;

    // Create a promise that will be resolved when approval is received
    return new Promise<boolean>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        reject(new Error('Tool approval request timed out'));
      }, this.APPROVAL_TIMEOUT);

      // Store the pending request
      const request: ApprovalRequest = {
        requestId,
        toolId,
        toolName,
        toolDescription: toolDescription || tool?.description || undefined,
        args,
        isWrite,
        sessionId,
        chatId,
        resolve,
        reject,
        timeout,
      };
      this.pendingApprovals.set(requestId, request);

      // Send approval request via WebSocket
      WebSocketService.broadcast({
        type: 'tool-approval-request',
        payload: {
          requestId,
          toolId,
          toolName,
          toolDescription: request.toolDescription,
          args,
          isWrite,
          sessionId,
          chatId,
        },
      });

      log.info(`Sent approval request ${requestId} for tool ${toolId}`);
    });
  }

  /**
   * Handle approval response from the frontend
   */
  handleApprovalResponse(
    requestId: string,
    decision: 'approve' | 'approve_always' | 'decline',
    sessionId: string
  ): void {
    const request = this.pendingApprovals.get(requestId);
    if (!request) {
      log.warn(`Received approval response for unknown request: ${requestId}`);
      return;
    }

    // Clear the timeout
    if (request.timeout) {
      clearTimeout(request.timeout);
    }

    // Remove from pending
    this.pendingApprovals.delete(requestId);

    // Handle the decision
    if (decision === 'approve' || decision === 'approve_always') {
      // Add session rule if "always approve"
      if (decision === 'approve_always') {
        this.addSessionRule(sessionId, request.toolId, request.args, 'always_approve');
      }

      log.info(`Tool ${request.toolId} approved (${decision})`);
      request.resolve(true);
    } else {
      // For decline, we might want to add a session rule in the future
      // For now, just reject the tool call
      log.info(`Tool ${request.toolId} declined`);
      request.resolve(false);
    }
  }

  /**
   * Clear session rules (e.g., when a chat session ends)
   */
  clearSessionRules(sessionId: string): void {
    if (this.sessionApprovalRules.has(sessionId)) {
      this.sessionApprovalRules.delete(sessionId);
      log.info(`Cleared session rules for ${sessionId}`);
    }
  }

  /**
   * Clear all pending approvals for a session
   */
  clearPendingApprovals(sessionId: string): void {
    const toDelete: string[] = [];

    this.pendingApprovals.forEach((request, requestId) => {
      if (request.sessionId === sessionId) {
        if (request.timeout) {
          clearTimeout(request.timeout);
        }
        toDelete.push(requestId);
        request.reject(new Error('Session ended'));
      }
    });

    toDelete.forEach((id) => this.pendingApprovals.delete(id));

    if (toDelete.length > 0) {
      log.info(`Cleared ${toDelete.length} pending approvals for session ${sessionId}`);
    }
  }

  /**
   * Get all pending approvals (useful for UI)
   */
  getPendingApprovals(): Map<string, ApprovalRequest> {
    return new Map(this.pendingApprovals);
  }

  /**
   * Get pending approvals for a specific session
   */
  getPendingApprovalsForSession(sessionId: string): ApprovalRequest[] {
    const approvals: ApprovalRequest[] = [];
    this.pendingApprovals.forEach((request) => {
      if (request.sessionId === sessionId) {
        approvals.push(request);
      }
    });
    return approvals;
  }

  /**
   * Get session rules for a specific session
   */
  getSessionRules(sessionId: string): Map<string, 'always_approve' | 'always_decline'> | undefined {
    return this.sessionApprovalRules.get(sessionId);
  }

  /**
   * Wrap a tool with approval logic
   */
  wrapToolWithApproval(tool: any, toolId: string, sessionId: string, chatId: number): any {
    // If tool doesn't have an execute function, return as is
    if (!tool.execute) {
      return tool;
    }

    const originalExecute = tool.execute;

    return {
      ...tool,
      execute: async (args: any) => {
        // Request approval
        const approved = await this.requestApproval(
          toolId,
          deconstructToolId(toolId).toolName,
          args,
          sessionId,
          chatId,
          tool.description
        );

        if (!approved) {
          throw new Error(`Tool execution declined by user: ${toolId}`);
        }

        // Execute the original tool
        return originalExecute(args);
      },
    };
  }

  /**
   * Clear all data (useful for testing)
   */
  clearAll(): void {
    // Clear all timeouts
    this.pendingApprovals.forEach((request) => {
      if (request.timeout) {
        clearTimeout(request.timeout);
      }
    });

    this.pendingApprovals.clear();
    this.sessionApprovalRules.clear();
  }
}

// Export singleton instance and convenience functions
export default new ToolService();
