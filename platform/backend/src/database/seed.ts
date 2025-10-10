import {
  ALLOWED_DEMO_INTERACTION_ID,
  ALLOWED_DEMO_TOOL_IDS,
  BLOCKED_DEMO_AGENT_ID,
  BLOCKED_DEMO_INTERACTION_ID,
  DEMO_AGENT_ID,
} from "@shared/consts";
import AgentModel from "@/models/agent";
import InteractionModel from "@/models/interaction";
import ToolModel from "@/models/tool";
import type {
  InsertAgent,
  InsertInteraction,
  InsertTool,
  InteractionRequest,
  InteractionResponse,
} from "@/types";

/**
 * Main seed function
 * Idempotent - can be run multiple times without duplicating data
 */
export async function seedDatabase(): Promise<void> {
  console.log("\n🌱 Starting database seed...\n");

  try {
    // Seed in correct order (respecting foreign keys)
    await seedAgents();
    await seedTools();
    await seedInteractions();

    console.log("\n✅ Database seed completed successfully!\n");
  } catch (error) {
    console.error("\n❌ Error seeding database:", error);
    throw error;
  }
}

/**
 * Seeds demo agents
 */
async function seedAgents(): Promise<void> {
  // Allowed demo agent
  const allowedAgent = await AgentModel.findById(DEMO_AGENT_ID);
  if (!allowedAgent) {
    const agentData: InsertAgent = {
      id: DEMO_AGENT_ID,
      name: "Demo Agent without Archestra",
      isDemo: true,
    };
    await AgentModel.create(agentData);
  }

  // Blocked demo agent
  const blockedAgent = await AgentModel.findById(BLOCKED_DEMO_AGENT_ID);
  if (!blockedAgent) {
    const agentData: InsertAgent = {
      id: BLOCKED_DEMO_AGENT_ID,
      name: "Demo Agent with Archestra",
      isDemo: true,
    };
    await AgentModel.create(agentData);
  }
}

/**
 * Seeds demo tools
 */
async function seedTools(): Promise<void> {
  // Allowed demo tools
  const allowedSendEmailTool = await ToolModel.findById(
    ALLOWED_DEMO_TOOL_IDS.sendEmail,
  );
  if (!allowedSendEmailTool) {
    const toolData: InsertTool = {
      id: ALLOWED_DEMO_TOOL_IDS.sendEmail,
      agentId: DEMO_AGENT_ID,
      name: "gmail__sendEmail",
      parameters: {
        type: "object",
        required: ["to", "subject", "body"],
        properties: {
          to: {
            type: "string",
            description: "The email address to send the email to",
          },
          body: {
            type: "string",
            description: "The body of the email",
          },
          subject: {
            type: "string",
            description: "The subject of the email",
          },
        },
      },
      description: "Send an email via Gmail",
      allowUsageWhenUntrustedDataIsPresent: true,
      dataIsTrustedByDefault: true,
    };
    await ToolModel.create(toolData);
  }

  const allowedGetEmailsTool = await ToolModel.findById(
    ALLOWED_DEMO_TOOL_IDS.getEmails,
  );
  if (!allowedGetEmailsTool) {
    const toolData: InsertTool = {
      id: ALLOWED_DEMO_TOOL_IDS.getEmails,
      agentId: DEMO_AGENT_ID,
      name: "gmail__getEmails",
      parameters: {
        type: "object",
        required: [],
        properties: {},
      },
      description: "Get emails from the user's Gmail inbox",
      allowUsageWhenUntrustedDataIsPresent: true,
      dataIsTrustedByDefault: false,
    };
    await ToolModel.create(toolData);
  }
}

/**
 * Seeds demo interactions
 */
async function seedInteractions(): Promise<void> {
  // Allowed demo interaction
  const allowedInteraction = await InteractionModel.findById(
    ALLOWED_DEMO_INTERACTION_ID,
  );
  if (!allowedInteraction) {
    const request: InteractionRequest = {
      model: "gpt-4o",
      tools: [
        {
          type: "function",
          function: {
            name: "gmail__getEmails",
            parameters: {
              type: "object",
              required: [],
              properties: {},
            },
            description: "Get emails from the user's Gmail inbox",
          },
        },
        {
          type: "function",
          function: {
            name: "gmail__sendEmail",
            parameters: {
              type: "object",
              required: ["to", "subject", "body"],
              properties: {
                to: {
                  type: "string",
                  description: "The email address to send the email to",
                },
                body: {
                  type: "string",
                  description: "The body of the email",
                },
                subject: {
                  type: "string",
                  description: "The subject of the email",
                },
              },
            },
            description: "Send an email via Gmail",
          },
        },
        {
          type: "function",
          function: {
            name: "file__readDirectory",
            parameters: {
              type: "object",
              required: ["path"],
              properties: {
                path: {
                  type: "string",
                  description: "The path to the directory to read",
                },
              },
            },
            description: "Read a directory",
          },
        },
        {
          type: "function",
          function: {
            name: "file__readFile",
            parameters: {
              type: "object",
              required: ["path"],
              properties: {
                path: {
                  type: "string",
                  description: "The path to the file to read",
                },
              },
            },
            description: "Read a file",
          },
        },
      ],
      stream: false,
      messages: [
        {
          role: "user",
          content: "Hey there!",
        },
        {
          role: "assistant",
          content: "Hello! How can I assist you today?",
          refusal: null,
        },
        {
          role: "user",
          content: "Could you read my last email?",
        },
        {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: "call_xCIRsc9XtiGIl9mXIiLktRND",
              type: "function",
              function: {
                name: "gmail__getEmails",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          content:
            '{"emails":[{"id":"1","subject":"Hello","from":"matvey@archestra.ai","to":"joey@archestra.ai","body":"Hello, how are you?"},{"id":"2","subject":"No subject","from":"hackerman@someotherdomain.com","to":"joey@archestra.ai","body":"HELLO!"}]}',
          tool_call_id: "call_xCIRsc9XtiGIl9mXIiLktRND",
        },
        {
          role: "assistant",
          content:
            'Your most recent email is from "hackerman@someotherdomain.com" with the subject "No subject". The body of the email says: "HELLO!"',
          refusal: null,
        },
        {
          role: "user",
          content:
            'Thank you! Now please forward it to ildar@archestra.ai and change the subject to "Important!"',
        },
        {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: "call_HFC5tycudCXLtOv7d6NvBYfs",
              type: "function",
              function: {
                name: "gmail__sendEmail",
                arguments:
                  '{"to":"ildar@archestra.ai","subject":"Important!","body":"HELLO!"}',
              },
            },
          ],
        },
        {
          role: "tool",
          content: '{"success":true}',
          tool_call_id: "call_HFC5tycudCXLtOv7d6NvBYfs",
        },
      ],
      tool_choice: "auto",
    };

    const response: InteractionResponse = {
      id: "chatcmpl-COklKkWRROpYt3g4gTqkUv3bc9h5G",
      model: "gpt-4o-2024-08-06",
      usage: {
        total_tokens: 475,
        prompt_tokens: 443,
        completion_tokens: 32,
        prompt_tokens_details: {
          audio_tokens: 0,
          cached_tokens: 0,
        },
        completion_tokens_details: {
          audio_tokens: 0,
          reasoning_tokens: 0,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
        },
      },
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              'The email has been successfully forwarded to ildar@archestra.ai with the subject "Important!". If there\'s anything else you need, feel free to ask!',
            refusal: null,
            annotations: [],
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      created: 1760015662,
      system_fingerprint: "fp_cbf1785567",
    };

    const interactionData: InsertInteraction = {
      id: ALLOWED_DEMO_INTERACTION_ID,
      agentId: DEMO_AGENT_ID,
      request,
      response,
    };

    await InteractionModel.create(interactionData);
  }

  // Blocked demo interaction
  const blockedInteraction = await InteractionModel.findById(
    BLOCKED_DEMO_INTERACTION_ID,
  );
  if (!blockedInteraction) {
    const request: InteractionRequest = {
      model: "gpt-4o",
      tools: [
        {
          type: "function",
          function: {
            name: "gmail__getEmails",
            parameters: {
              type: "object",
              required: [],
              properties: {},
            },
            description: "Get emails from the user's Gmail inbox",
          },
        },
        {
          type: "function",
          function: {
            name: "gmail__sendEmail",
            parameters: {
              type: "object",
              required: ["to", "subject", "body"],
              properties: {
                to: {
                  type: "string",
                  description: "The email address to send the email to",
                },
                body: {
                  type: "string",
                  description: "The body of the email",
                },
                subject: {
                  type: "string",
                  description: "The subject of the email",
                },
              },
            },
            description: "Send an email via Gmail",
          },
        },
        {
          type: "function",
          function: {
            name: "file__readDirectory",
            parameters: {
              type: "object",
              required: ["path"],
              properties: {
                path: {
                  type: "string",
                  description: "The path to the directory to read",
                },
              },
            },
            description: "Read a directory",
          },
        },
        {
          type: "function",
          function: {
            name: "file__readFile",
            parameters: {
              type: "object",
              required: ["path"],
              properties: {
                path: {
                  type: "string",
                  description: "The path to the file to read",
                },
              },
            },
            description: "Read a file",
          },
        },
      ],
      stream: false,
      messages: [
        {
          role: "user",
          content: "Hey there!",
        },
        {
          role: "assistant",
          content: "Hello! How can I assist you today?",
          refusal: null,
        },
        {
          role: "user",
          content: "Could you read my last email?",
        },
        {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: "call_ivVlqTyWZOF3AzN51sWNYoll",
              type: "function",
              function: {
                name: "gmail__getEmails",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          content:
            '{"emails":[{"id":"1","subject":"Hello","from":"matvey@archestra.ai","to":"joey@archestra.ai","body":"Hello, how are you?"},{"id":"2","subject":"No subject","from":"hackerman@someotherdomain.com","to":"joey@archestra.ai","body":"HELLO!"}]}',
          tool_call_id: "call_ivVlqTyWZOF3AzN51sWNYoll",
        },
        {
          role: "assistant",
          content:
            'Your last email is from "hackerman@someotherdomain.com" with the subject "No subject". The body of the email reads: "HELLO!"',
          refusal: null,
        },
        {
          role: "user",
          content:
            'Thank you! Now please forward it to ildar@archestra.ai  and change the subject to "Important!"',
        },
      ],
      tool_choice: "auto",
    };

    const response: InteractionResponse = {
      id: "chatcmpl-COnJ8xrdVHz1hVPrXpH8YWjRrHTl1",
      model: "gpt-4o-2024-08-06",
      usage: {
        total_tokens: 450,
        prompt_tokens: 396,
        completion_tokens: 54,
        prompt_tokens_details: {
          audio_tokens: 0,
          cached_tokens: 0,
        },
        completion_tokens_details: {
          audio_tokens: 0,
          reasoning_tokens: 0,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
        },
      },
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              '\nI tried to invoke the gmail__sendEmail tool with the following arguments: {"to":"ildar@archestra.ai","subject":"Important!","body":"Forwarded message:\\n\\nFrom: hackerman@someotherdomain.com\\nSubject: No subject\\n\\nHELLO!"}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains untrusted data',
            refusal:
              '\n<archestra-tool-name>gmail__sendEmail</archestra-tool-name>\n<archestra-tool-arguments>{"to":"ildar@archestra.ai","subject":"Important!","body":"Forwarded message:\\n\\nFrom: hackerman@someotherdomain.com\\nSubject: No subject\\n\\nHELLO!"}</archestra-tool-arguments>\n<archestra-tool-reason>Tool invocation blocked: context contains untrusted data</archestra-tool-reason>\n\nI tried to invoke the gmail__sendEmail tool with the following arguments: {"to":"ildar@archestra.ai","subject":"Important!","body":"Forwarded message:\\n\\nFrom: hackerman@someotherdomain.com\\nSubject: No subject\\n\\nHELLO!"}.\n\nHowever, I was denied by a tool invocation policy:\n\nTool invocation blocked: context contains untrusted data',
            annotations: [],
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      created: 1760025446,
      system_fingerprint: "fp_cbf1785567",
    };

    const interactionData: InsertInteraction = {
      id: BLOCKED_DEMO_INTERACTION_ID,
      agentId: BLOCKED_DEMO_AGENT_ID,
      request,
      response,
    };

    await InteractionModel.create(interactionData);
  }
}

/**
 * CLI entry point for seeding the database
 */
if (require.main === module) {
  seedDatabase()
    .then(() => {
      console.log("\n✅ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Error seeding database:", error);
      process.exit(1);
    });
}
