import { openai } from '@ai-sdk/openai';
import {
  ModelMessage,
  ToolResultPart,
  generateText,
  stepCountIs,
  wrapLanguageModel,
} from 'ai';

import 'dotenv/config';
import * as readline from 'node:readline/promises';

import parseArgs from './cli';
import { autonomyPolicyGuardrailsMiddleware } from './middleware';
import { type ToolStaticAutonomyPolicy } from './security';
import { getTools } from './tools';

const MODEL = openai('gpt-4o');
const MAX_TOOL_CALLS = 5;
const TOOL_AUTONOMY_POLICIES: ToolStaticAutonomyPolicy[] = [
  // Response policy: Only allow emails from @archestra.ai domains
  {
    mcpServerName: 'gmail',
    toolName: 'getEmails',
    description: 'E-mails from @archestra.ai domains are safe',
    attributePath: 'emails[*].from',
    operator: 'endsWith',
    value: '@archestra.ai',
    allow: true,
  },
  // Invocation policy: Cannot send emails to @grafana.com domain
  {
    mcpServerName: 'gmail',
    toolName: 'sendEmail',
    description: 'Cannot send emails to @grafana.com domain',
    argumentName: 'to',
    operator: 'endsWith',
    value: '@grafana.com',
    allow: false,
  },
  // Invocation policy: Block reading sensitive files
  {
    mcpServerName: 'file',
    toolName: 'readFile',
    description: 'Cannot read SSH keys',
    argumentName: 'path',
    operator: 'contains',
    value: '.ssh',
    allow: false,
  },
  {
    mcpServerName: 'file',
    toolName: 'readFile',
    description: 'Cannot read environment files',
    argumentName: 'path',
    operator: 'contains',
    value: '.env',
    allow: false,
  },
];

const printAssistantResponseMessages = (messages: ModelMessage[]) => {
  process.stdout.write('\nAssistant: ');

  for (const message of messages) {
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        process.stdout.write(message.content);
      } else if (Array.isArray(message.content)) {
        // Handle structured content from assistant
        for (const content of message.content) {
          if (content.type === 'text') {
            process.stdout.write(content.text);
          } else if (content.type === 'tool-call') {
            process.stdout.write(`\n📞 Calling tool: ${content.toolName}\n`);
            process.stdout.write(
              `   Input: ${JSON.stringify(content.input, null, 2)}\n`
            );
          }
        }
      }
    } else if (message.role === 'tool') {
      // Show tool results in a more readable format
      if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === 'tool-result') {
            const toolResult = content as ToolResultPart;
            process.stdout.write(
              `\n📦 Tool Result (${toolResult.toolName}):\n`
            );
            const output = toolResult.output?.value || toolResult.output;
            if (output) {
              process.stdout.write(JSON.stringify(output, null, 2));
            }
          }
        }
      }
    } else {
      // Fallback for other message types
      process.stdout.write(JSON.stringify(message));
    }
  }
};

const cliChatWithGuardrails = async () => {
  const {
    dynamicAutonomyPolicyEvaluatorType,
    includeExternalEmail,
    includeMaliciousEmail,
  } = parseArgs();

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: ModelMessage[] = [];

  console.log('Type exit() to exit\n');

  while (true) {
    const userInput = await terminal.question('You: ');

    if (userInput === 'exit()') {
      console.log('Exiting...');
      process.exit(0);
    }

    messages.push({ role: 'user', content: userInput });

    const {
      response: { messages: newMessages },
    } = await generateText({
      model: wrapLanguageModel({
        model: MODEL,
        middleware: autonomyPolicyGuardrailsMiddleware({
          staticPolicies: TOOL_AUTONOMY_POLICIES,
          dynamicEvaluatorType: dynamicAutonomyPolicyEvaluatorType,
        }),
      }),
      messages,
      tools: getTools(includeExternalEmail, includeMaliciousEmail),
      toolChoice: 'auto',
      stopWhen: ({ steps }) => {
        // Stop if we've reached max tool calls
        return stepCountIs(MAX_TOOL_CALLS)({ steps });
      },
    });

    printAssistantResponseMessages(newMessages);
    messages.push(...newMessages);

    process.stdout.write('\n\n');
  }
};

cliChatWithGuardrails().catch(console.error);
