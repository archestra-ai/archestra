import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import config from '@backend/config';
import McpServerSandboxManager from '@backend/sandbox/manager';
import { SandboxStatusSummarySchema } from '@backend/sandbox/schemas';
import toolService from '@backend/services/tool';
import log from '@backend/utils/logger';

const OllamaModelDownloadProgressWebsocketPayloadSchema = z.object({
  model: z.string(),
  status: z.enum(['downloading', 'verifying', 'completed', 'error']),
  progress: z.number().min(0).max(100),
  message: z.string(),
});

const ChatTitleUpdatedPayloadSchema = z.object({
  chatId: z.number(),
  title: z.string(),
});

const MemoryUpdatedPayloadSchema = z.object({
  memories: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      value: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
  ),
});

const ChatToolsUpdatedPayloadSchema = z.object({
  chatId: z.number(),
  selectedTools: z.array(z.string()).nullable(),
});

const ToolsUpdatedPayloadSchema = z.object({
  mcpServerId: z.string(),
  message: z.string(),
});

const ToolAnalysisProgressPayloadSchema = z.object({
  mcpServerId: z.string().optional(),
  status: z.enum(['started', 'analyzing', 'completed', 'error']),
  progress: z.number().min(0).max(100).optional(),
  totalTools: z.number().optional(),
  analyzedTools: z.number().optional(),
  currentTool: z.string().optional(),
  message: z.string(),
  error: z.string().optional(),
});

const ChatTokenUsageUpdatedPayloadSchema = z.object({
  chatId: z.number(),
  totalPromptTokens: z.number().nullable(),
  totalCompletionTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  lastModel: z.string().nullable(),
  lastContextWindow: z.number().nullable(),
  contextUsagePercent: z.number(),
});

const ToolApprovalRequestPayloadSchema = z.object({
  requestId: z.string(),
  toolId: z.string(),
  toolName: z.string(),
  toolDescription: z.string().optional(),
  args: z.record(z.string(), z.any()),
  isWrite: z.boolean(),
  sessionId: z.string(),
  chatId: z.number(),
});

const ToolApprovalResponsePayloadSchema = z.object({
  requestId: z.string(),
  decision: z.enum(['approve', 'approve_always', 'decline']),
  sessionId: z.string(),
});

export const WebSocketMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat-title-updated'), payload: ChatTitleUpdatedPayloadSchema }),
  z.object({ type: z.literal('chat-tools-updated'), payload: ChatToolsUpdatedPayloadSchema }),
  z.object({ type: z.literal('sandbox-status-update'), payload: SandboxStatusSummarySchema }),
  z.object({
    type: z.literal('ollama-model-download-progress'),
    payload: OllamaModelDownloadProgressWebsocketPayloadSchema,
  }),
  z.object({ type: z.literal('memory-updated'), payload: MemoryUpdatedPayloadSchema }),
  z.object({ type: z.literal('tools-updated'), payload: ToolsUpdatedPayloadSchema }),
  z.object({ type: z.literal('tool-analysis-progress'), payload: ToolAnalysisProgressPayloadSchema }),
  z.object({ type: z.literal('chat-token-usage-updated'), payload: ChatTokenUsageUpdatedPayloadSchema }),
  z.object({ type: z.literal('tool-approval-request'), payload: ToolApprovalRequestPayloadSchema }),
  z.object({ type: z.literal('tool-approval-response'), payload: ToolApprovalResponsePayloadSchema }),
]);

// type ChatTitleUpdatedPayload = z.infer<typeof ChatTitleUpdatedPayloadSchema>;
type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;

/**
 * Register our zod schemas into the global registry, such that they get output as components in the openapi spec
 * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
 */
z.globalRegistry.add(OllamaModelDownloadProgressWebsocketPayloadSchema, {
  id: 'OllamaModelDownloadProgress',
});
z.globalRegistry.add(ToolApprovalRequestPayloadSchema, {
  id: 'ToolApprovalRequest',
});
z.globalRegistry.add(ToolApprovalResponsePayloadSchema, {
  id: 'ToolApprovalResponse',
});

class WebSocketService {
  private wss: WebSocketServer | null = null;
  private sandboxStatusInterval: NodeJS.Timeout | null = null;

  start() {
    const { port } = config.server.websocket;

    this.wss = new WebSocketServer({ port });

    log.info(`WebSocket server started on port ${port}`);

    this.wss.on('connection', (ws: WebSocket) => {
      log.info(`WebSocket client connected. Total connections: ${this.wss?.clients.size}`);

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          log.info('Received WebSocket message:', message);

          // Handle tool approval responses
          if (message.type === 'tool-approval-response') {
            log.info('Handling tool approval response:', message.payload);
            toolService.handleApprovalResponse(
              message.payload.requestId,
              message.payload.decision,
              message.payload.sessionId
            );
          } else {
            log.info('Unknown WebSocket message type:', message.type);
          }
        } catch (error) {
          log.error('Failed to parse WebSocket message:', error);
        }
      });

      ws.on('close', () => {
        log.info(`WebSocket client disconnected. Remaining connections: ${this.wss?.clients.size}`);
      });

      ws.on('error', (error) => {
        log.error('WebSocket error:', error);
      });
    });

    this.wss.on('error', (error) => {
      log.error('WebSocket server error:', error);
    });

    this.periodicallyEmitSandboxStatusSummaryUpdates();
  }

  broadcast(message: WebSocketMessage) {
    if (!this.wss) {
      log.warn('WebSocket server not initialized');
      return;
    }

    const messageStr = JSON.stringify(message);
    const clientCount = this.wss.clients.size;

    let sentCount = 0;
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
        sentCount++;
      }
    });

    if (sentCount < clientCount) {
      log.info(`Only sent to ${sentCount}/${clientCount} clients (some were not ready)`);
    }
  }

  stop() {
    // Clear the interval first
    if (this.sandboxStatusInterval) {
      clearInterval(this.sandboxStatusInterval);
      this.sandboxStatusInterval = null;
      log.info('Cleared sandbox status interval');
    }

    // Close all client connections
    if (this.wss) {
      this.wss.clients.forEach((client) => {
        client.close();
      });

      this.wss.close(() => {
        log.info('WebSocket server closed');
      });
      this.wss = null;
    }
  }

  private periodicallyEmitSandboxStatusSummaryUpdates() {
    this.sandboxStatusInterval = setInterval(() => {
      this.broadcast({
        type: 'sandbox-status-update',
        /**
         * Create an enhanced payload that includes all tools
         * We'll add a new field for all aggregated tools while keeping the existing structure
         */
        payload: {
          // Get the base status summary from sandbox manager
          ...McpServerSandboxManager.statusSummary,
          // Get all aggregated tools (includes both sandboxed and Archestra tools) -- add as a separate field
          allAvailableTools: toolService.getAllAvailableTools(),
        },
      });
    }, 1000);
  }
}

export default new WebSocketService();
