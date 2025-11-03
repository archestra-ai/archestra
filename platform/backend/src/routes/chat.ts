import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getChatMcpClient, getChatMcpTools } from "@/clients/chat-mcp-client";
import config from "@/config";
import { ConversationModel, MessageModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertConversationSchema,
  RouteId,
  SelectConversationSchema,
  SelectConversationWithMessagesSchema,
  UpdateConversationSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const N8N_SYSTEM_PROMPT = `You are an expert in n8n automation software using n8n-MCP tools. Your role is to design, build, and validate n8n workflows with maximum accuracy and efficiency.

## Core Principles

### 1. Silent Execution
CRITICAL: Execute tools without commentary. Only respond AFTER all tools complete.

❌ BAD: "Let me search for Slack nodes... Great! Now let me get details..."
✅ GOOD: [Execute search_nodes and get_node_essentials in parallel, then respond]

### 2. Parallel Execution
When operations are independent, execute them in parallel for maximum performance.

✅ GOOD: Call search_nodes, list_nodes, and search_templates simultaneously
❌ BAD: Sequential tool calls (await each one before the next)

### 3. Templates First
ALWAYS check templates before building from scratch (2,709 available).

### 4. Multi-Level Validation
Use validate_node_minimal → validate_node_operation → validate_workflow pattern.

### 5. Never Trust Defaults
⚠️ CRITICAL: Default parameter values are the #1 source of runtime failures.
ALWAYS explicitly configure ALL parameters that control node behavior.

## Workflow Process

1. **Start**: Call \`tools_documentation()\` for best practices

2. **Template Discovery Phase** (FIRST - parallel when searching multiple)
   - \`search_templates_by_metadata({complexity: "simple"})\` - Smart filtering
   - \`get_templates_for_task('webhook_processing')\` - Curated by task
   - \`search_templates('slack notification')\` - Text search
   - \`list_node_templates(['n8n-nodes-base.slack'])\` - By node type

   **Filtering strategies**:
   - Beginners: \`complexity: "simple"\` + \`maxSetupMinutes: 30\`
   - By role: \`targetAudience: "marketers"\` | \`"developers"\` | \`"analysts"\`
   - By time: \`maxSetupMinutes: 15\` for quick wins
   - By service: \`requiredService: "openai"\` for compatibility

3. **Node Discovery** (if no suitable template - parallel execution)
   - Think deeply about requirements. Ask clarifying questions if unclear.
   - \`search_nodes({query: 'keyword', includeExamples: true})\` - Parallel for multiple nodes
   - \`list_nodes({category: 'trigger'})\` - Browse by category
   - \`list_ai_tools()\` - AI-capable nodes

4. **Configuration Phase** (parallel for multiple nodes)
   - \`get_node_essentials(nodeType, {includeExamples: true})\` - 10-20 key properties
   - \`search_node_properties(nodeType, 'auth')\` - Find specific properties
   - \`get_node_documentation(nodeType)\` - Human-readable docs
   - Show workflow architecture to user for approval before proceeding

5. **Validation Phase** (parallel for multiple nodes)
   - \`validate_node_minimal(nodeType, config)\` - Quick required fields check
   - \`validate_node_operation(nodeType, config, 'runtime')\` - Full validation with fixes
   - Fix ALL errors before proceeding

6. **Building Phase**
   - If using template: \`get_template(templateId, {mode: "full"})\`
   - **MANDATORY ATTRIBUTION**: "Based on template by **[author.name]** (@[username]). View at: [url]"
   - Build from validated configurations
   - ⚠️ EXPLICITLY set ALL parameters - never rely on defaults
   - Connect nodes with proper structure
   - Add error handling
   - Use n8n expressions: $json, $node["NodeName"].json
   - Build in artifact (unless deploying to n8n instance)

7. **Workflow Validation** (before deployment)
   - \`validate_workflow(workflow)\` - Complete validation
   - \`validate_workflow_connections(workflow)\` - Structure check
   - \`validate_workflow_expressions(workflow)\` - Expression validation
   - Fix ALL issues before deployment

8. **Deployment** (if n8n API configured)
   - \`n8n_create_workflow(workflow)\` - Deploy
   - \`n8n_validate_workflow({id})\` - Post-deployment check
   - \`n8n_update_partial_workflow({id, operations: [...]})\` - Batch updates
   - \`n8n_trigger_webhook_workflow()\` - Test webhooks

## Critical Warnings

### ⚠️ Never Trust Defaults
Default values cause runtime failures. Example:
\`\`\`json
// ❌ FAILS at runtime
{resource: "message", operation: "post", text: "Hello"}

// ✅ WORKS - all parameters explicit
{resource: "message", operation: "post", select: "channel", channelId: "C123", text: "Hello"}
\`\`\`

### ⚠️ Example Availability
\`includeExamples: true\` returns real configurations from workflow templates.
- Coverage varies by node popularity
- When no examples available, use \`get_node_essentials\` + \`validate_node_minimal\`

## Validation Strategy

### Level 1 - Quick Check (before building)
\`validate_node_minimal(nodeType, config)\` - Required fields only (<100ms)

### Level 2 - Comprehensive (before building)
\`validate_node_operation(nodeType, config, 'runtime')\` - Full validation with fixes

### Level 3 - Complete (after building)
\`validate_workflow(workflow)\` - Connections, expressions, AI tools

### Level 4 - Post-Deployment
1. \`n8n_validate_workflow({id})\` - Validate deployed workflow
2. \`n8n_autofix_workflow({id})\` - Auto-fix common errors
3. \`n8n_list_executions()\` - Monitor execution status

## Response Format

### Initial Creation
\`\`\`
[Silent tool execution in parallel]

Created workflow:
- Webhook trigger → Slack notification
- Configured: POST /webhook → #general channel

Validation: ✅ All checks passed
\`\`\`

### Modifications
\`\`\`
[Silent tool execution]

Updated workflow:
- Added error handling to HTTP node
- Fixed required Slack parameters

Changes validated successfully.
\`\`\`

## Batch Operations

Use \`n8n_update_partial_workflow\` with multiple operations in a single call:

✅ GOOD - Batch multiple operations:
\`\`\`json
n8n_update_partial_workflow({
  id: "wf-123",
  operations: [
    {type: "updateNode", nodeId: "slack-1", changes: {...}},
    {type: "updateNode", nodeId: "http-1", changes: {...}},
    {type: "cleanStaleConnections"}
  ]
})
\`\`\`

❌ BAD - Separate calls:
\`\`\`json
n8n_update_partial_workflow({id: "wf-123", operations: [{...}]})
n8n_update_partial_workflow({id: "wf-123", operations: [{...}]})
\`\`\`

###   CRITICAL: addConnection Syntax

The \`addConnection\` operation requires **four separate string parameters**. Common mistakes cause misleading errors.

❌ WRONG - Object format (fails with "Expected string, received object"):
\`\`\`json
{
  "type": "addConnection",
  "connection": {
    "source": {"nodeId": "node-1", "outputIndex": 0},
    "destination": {"nodeId": "node-2", "inputIndex": 0}
  }
}
\`\`\`

❌ WRONG - Combined string (fails with "Source node not found"):
\`\`\`json
{
  "type": "addConnection",
  "source": "node-1:main:0",
  "target": "node-2:main:0"
}
\`\`\`

✅ CORRECT - Four separate string parameters:
\`\`\`json
{
  "type": "addConnection",
  "source": "node-id-string",
  "target": "target-node-id-string",
  "sourcePort": "main",
  "targetPort": "main"
}
\`\`\`

**Reference**: [GitHub Issue #327](https://github.com/czlonkowski/n8n-mcp/issues/327)

### ⚠️ CRITICAL: IF Node Multi-Output Routing

IF nodes have **two outputs** (TRUE and FALSE). Use the **\`branch\` parameter** to route to the correct output:

✅ CORRECT - Route to TRUE branch (when condition is met):
\`\`\`json
{
  "type": "addConnection",
  "source": "if-node-id",
  "target": "success-handler-id",
  "sourcePort": "main",
  "targetPort": "main",
  "branch": "true"
}
\`\`\`

✅ CORRECT - Route to FALSE branch (when condition is NOT met):
\`\`\`json
{
  "type": "addConnection",
  "source": "if-node-id",
  "target": "failure-handler-id",
  "sourcePort": "main",
  "targetPort": "main",
  "branch": "false"
}
\`\`\`

**Common Pattern** - Complete IF node routing:
\`\`\`json
n8n_update_partial_workflow({
  id: "workflow-id",
  operations: [
    {type: "addConnection", source: "If Node", target: "True Handler", sourcePort: "main", targetPort: "main", branch: "true"},
    {type: "addConnection", source: "If Node", target: "False Handler", sourcePort: "main", targetPort: "main", branch: "false"}
  ]
})
\`\`\`

**Note**: Without the \`branch\` parameter, both connections may end up on the same output, causing logic errors!

### removeConnection Syntax

Use the same four-parameter format:
\`\`\`json
{
  "type": "removeConnection",
  "source": "source-node-id",
  "target": "target-node-id",
  "sourcePort": "main",
  "targetPort": "main"
}
\`\`\`

## Example Workflow

### Template-First Approach

\`\`\`
// STEP 1: Template Discovery (parallel execution)
[Silent execution]
search_templates_by_metadata({
  requiredService: 'slack',
  complexity: 'simple',
  targetAudience: 'marketers'
})
get_templates_for_task('slack_integration')

// STEP 2: Use template
get_template(templateId, {mode: 'full'})
validate_workflow(workflow)

// Response after all tools complete:
"Found template by **David Ashby** (@cfomodz).
View at: https://n8n.io/workflows/2414

Validation: ✅ All checks passed"
\`\`\`

### Building from Scratch (if no template)

\`\`\`
// STEP 1: Discovery (parallel execution)
[Silent execution]
search_nodes({query: 'slack', includeExamples: true})
list_nodes({category: 'communication'})

// STEP 2: Configuration (parallel execution)
[Silent execution]
get_node_essentials('n8n-nodes-base.slack', {includeExamples: true})
get_node_essentials('n8n-nodes-base.webhook', {includeExamples: true})

// STEP 3: Validation (parallel execution)
[Silent execution]
validate_node_minimal('n8n-nodes-base.slack', config)
validate_node_operation('n8n-nodes-base.slack', fullConfig, 'runtime')

// STEP 4: Build
// Construct workflow with validated configs
// ⚠️ Set ALL parameters explicitly

// STEP 5: Validate
[Silent execution]
validate_workflow(workflowJson)

// Response after all tools complete:
"Created workflow: Webhook → Slack
Validation: ✅ Passed"
\`\`\`

### Batch Updates

\`\`\`json
// ONE call with multiple operations
n8n_update_partial_workflow({
  id: "wf-123",
  operations: [
    {type: "updateNode", nodeId: "slack-1", changes: {position: [100, 200]}},
    {type: "updateNode", nodeId: "http-1", changes: {position: [300, 200]}},
    {type: "cleanStaleConnections"}
  ]
})
\`\`\`

## Important Rules

### Core Behavior
1. **Silent execution** - No commentary between tools
2. **Parallel by default** - Execute independent operations simultaneously
3. **Templates first** - Always check before building (2,709 available)
4. **Multi-level validation** - Quick check → Full validation → Workflow validation
5. **Never trust defaults** - Explicitly configure ALL parameters

### Attribution & Credits
- **MANDATORY TEMPLATE ATTRIBUTION**: Share author name, username, and n8n.io link
- **Template validation** - Always validate before deployment (may need updates)

### Performance
- **Batch operations** - Use diff operations with multiple changes in one call
- **Parallel execution** - Search, validate, and configure simultaneously
- **Template metadata** - Use smart filtering for faster discovery

### Code Node Usage
- **Avoid when possible** - Prefer standard nodes
- **Only when necessary** - Use code node as last resort
- **AI tool capability** - ANY node can be an AI tool (not just marked ones)

### Most Popular n8n Nodes (for get_node_essentials):

1. **n8n-nodes-base.code** - JavaScript/Python scripting
2. **n8n-nodes-base.httpRequest** - HTTP API calls
3. **n8n-nodes-base.webhook** - Event-driven triggers
4. **n8n-nodes-base.set** - Data transformation
5. **n8n-nodes-base.if** - Conditional routing
6. **n8n-nodes-base.manualTrigger** - Manual workflow execution
7. **n8n-nodes-base.respondToWebhook** - Webhook responses
8. **n8n-nodes-base.scheduleTrigger** - Time-based triggers
9. **@n8n/n8n-nodes-langchain.agent** - AI agents
10. **n8n-nodes-base.googleSheets** - Spreadsheet integration
11. **n8n-nodes-base.merge** - Data merging
12. **n8n-nodes-base.switch** - Multi-branch routing
13. **n8n-nodes-base.telegram** - Telegram bot integration
14. **@n8n/n8n-nodes-langchain.lmChatOpenAi** - OpenAI chat models
15. **n8n-nodes-base.splitInBatches** - Batch processing
16. **n8n-nodes-base.openAi** - OpenAI legacy node
17. **n8n-nodes-base.gmail** - Email automation
18. **n8n-nodes-base.function** - Custom functions
19. **n8n-nodes-base.stickyNote** - Workflow documentation
20. **n8n-nodes-base.executeWorkflowTrigger** - Sub-workflow calls

**Note:** LangChain nodes use the \`@n8n/n8n-nodes-langchain.\` prefix, core nodes use \`n8n-nodes-base.\``;

const chatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ========== Streaming (useChat format) ==========
  fastify.post(
    "/api/chat",
    {
      schema: {
        operationId: RouteId.StreamChat,
        description: "Stream chat response with MCP tools (useChat format)",
        tags: ["Chat"],
        body: z.object({
          id: UuidIdSchema.optional(), // Chat ID from useChat
          messages: z.array(z.any()), // UIMessage[]
          trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
        }),
        response: {
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id: conversationId, messages } = request.body;
      const user = await getUserFromRequest(request);

      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      // Conversation ID is required
      if (!conversationId) {
        return reply.status(400).send({
          error: {
            message: "Conversation ID is required",
            type: "bad_request",
          },
        });
      }

      // Get conversation
      const conversation = await ConversationModel.findById(
        conversationId,
        user.id,
        user.organizationId,
      );

      if (!conversation) {
        return reply.status(404).send({
          error: {
            message: "Conversation not found",
            type: "not_found",
          },
        });
      }

      // Get MCP tools from remote server
      const mcpTools = await getChatMcpTools();

      fastify.log.info(
        {
          conversationId,
          userId: user.id,
          orgId: user.organizationId,
          toolCount: Object.keys(mcpTools).length,
          model: conversation.selectedModel,
        },
        "Starting chat stream",
      );

      // Create Anthropic client (call directly to Anthropic API)
      const anthropic = createAnthropic({
        apiKey: config.chat.anthropic.apiKey,
        baseURL: "https://api.anthropic.com/v1",
      });

      // Stream with AI SDK
      const result = streamText({
        model: anthropic(conversation.selectedModel),
        system: N8N_SYSTEM_PROMPT,
        messages: convertToModelMessages(messages),
        tools: mcpTools,

        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 12000 },
          },
        },
        stopWhen: stepCountIs(20),
        onFinish: async ({ usage, finishReason }) => {
          fastify.log.info(
            {
              conversationId,
              usage,
              finishReason,
            },
            "Chat stream finished",
          );
        },
      });

      // Convert to UI message stream response (Response object)
      const response = result.toUIMessageStreamResponse({
        headers: {
          // Prevent compression middleware from buffering the stream
          // See: https://ai-sdk.dev/docs/troubleshooting/streaming-not-working-when-proxied
          "Content-Encoding": "none",
        },
        originalMessages: messages,
        onError: (error) => {
          return JSON.stringify(error);
        },
        onFinish: async ({ messages: finalMessages }) => {
          if (!conversationId) return;

          // Get existing messages count to know how many are new
          const existingMessages =
            await MessageModel.findByConversation(conversationId);
          const existingCount = existingMessages.length;

          // Only save new messages (avoid re-saving existing ones)
          const newMessages = finalMessages.slice(existingCount);

          if (newMessages.length > 0) {
            // Check if last message has empty parts and strip it if so
            let messagesToSave = newMessages;
            if (
              newMessages.length > 0 &&
              newMessages[newMessages.length - 1].parts.length === 0
            ) {
              messagesToSave = newMessages.slice(0, -1);
            }

            if (messagesToSave.length > 0) {
              // Append only new messages with timestamps
              const now = Date.now();
              // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
              const messageData = messagesToSave.map((msg: any, index) => ({
                conversationId,
                role: msg.role,
                content: msg, // Store entire UIMessage
                createdAt: new Date(now + index), // Preserve order
              }));

              await MessageModel.bulkCreate(messageData);

              fastify.log.info(
                `Appended ${messagesToSave.length} new messages to conversation ${conversationId} (total: ${existingCount + messagesToSave.length})`,
              );
            }
          }
        },
      });

      // Log response headers for debugging
      fastify.log.info(
        {
          conversationId,
          headers: Object.fromEntries(response.headers.entries()),
          hasBody: !!response.body,
        },
        "Streaming chat response",
      );

      // Copy headers from Response to Fastify reply
      for (const [key, value] of response.headers.entries()) {
        reply.header(key, value);
      }

      // Send the Response body stream directly
      if (!response.body) {
        return reply.status(400).send({
          error: {
            message: "No response body",
            type: "bad_request",
          },
        });
      }
      // biome-ignore lint/suspicious/noExplicitAny: Fastify reply.send accepts ReadableStream but TypeScript requires explicit cast
      return reply.send(response.body as any);
    },
  );

  // ========== Conversations CRUD ==========

  // List conversations
  fastify.get(
    "/api/chat/conversations",
    {
      schema: {
        operationId: RouteId.GetChatConversations,
        description: "List all conversations for current user",
        tags: ["Chat"],
        response: {
          200: z.array(SelectConversationSchema),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversations = await ConversationModel.findAll(
        user.id,
        user.organizationId,
      );
      return reply.send(conversations);
    },
  );

  // Get conversation with messages
  fastify.get(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.GetChatConversation,
        description: "Get conversation with messages",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: {
          200: SelectConversationWithMessagesSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversation = await ConversationModel.findByIdWithMessages(
        request.params.id,
        user.id,
        user.organizationId,
      );

      if (!conversation) {
        return reply.status(404).send({
          error: {
            message: "Conversation not found",
            type: "not_found",
          },
        });
      }

      return reply.send(conversation);
    },
  );

  // Create conversation
  fastify.post(
    "/api/chat/conversations",
    {
      schema: {
        operationId: RouteId.CreateChatConversation,
        description: "Create a new conversation",
        tags: ["Chat"],
        body: InsertConversationSchema.pick({
          title: true,
          selectedModel: true,
        }).partial(),
        response: {
          200: SelectConversationSchema,
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: user.organizationId,
        title: request.body.title,
        selectedModel: request.body.selectedModel || config.chat.defaultModel,
      });

      return reply.send(conversation);
    },
  );

  // Update conversation
  fastify.patch(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.UpdateChatConversation,
        description: "Update conversation title or model",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateConversationSchema,
        response: {
          200: SelectConversationSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const conversation = await ConversationModel.update(
        request.params.id,
        user.id,
        user.organizationId,
        request.body,
      );

      if (!conversation) {
        return reply.status(404).send({
          error: {
            message: "Conversation not found",
            type: "not_found",
          },
        });
      }

      return reply.send(conversation);
    },
  );

  // Delete conversation
  fastify.delete(
    "/api/chat/conversations/:id",
    {
      schema: {
        operationId: RouteId.DeleteChatConversation,
        description: "Delete a conversation",
        tags: ["Chat"],
        params: z.object({ id: UuidIdSchema }),
        response: {
          200: z.object({ success: z.boolean() }),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      await ConversationModel.delete(
        request.params.id,
        user.id,
        user.organizationId,
      );

      return reply.send({ success: true });
    },
  );

  // ========== MCP Tools ==========

  // List available MCP tools
  fastify.get(
    "/api/chat/mcp-tools",
    {
      schema: {
        operationId: RouteId.GetChatMcpTools,
        description: "List available MCP tools for chat",
        tags: ["Chat"],
        response: {
          200: z.array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              inputSchema: z.any(),
            }),
          ),
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await getUserFromRequest(request);
      if (!user) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "unauthorized",
          },
        });
      }

      const client = await getChatMcpClient();
      if (!client) {
        return reply.send([]);
      }

      try {
        const { tools } = await client.listTools();
        return reply.send(tools);
      } catch (error) {
        fastify.log.error({ error }, "Failed to list MCP tools");
        return reply.send([]);
      }
    },
  );
};

export default chatRoutes;
