import { openai } from '@ai-sdk/openai';
import { ModelMessage, ToolResultPart, generateText, stepCountIs } from 'ai';

import 'dotenv/config';
import * as readline from 'node:readline/promises';

import parseArgs from './cli';
import {
  type StaticAutonomyPolicy,
  ContextCredibilityEvaluator,
} from './security';
import { getTools } from './tools';

const MODEL = openai('gpt-4o');
const MAX_TOOL_CALLS = 5;
const STATIC_AUTONOMY_POLICIES: StaticAutonomyPolicy[] = [
  {
    mcpServerName: 'gmail',
    toolName: 'getEmails',
    description: 'E-mails from @archestra.ai domains are safe',
    attribute: 'emails[*].from',
    operator: 'endsWith',
    value: '@archestra.ai',
    allow: true,
  },
];

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

    const { response } = await generateText({
      model: MODEL,
      messages,
      tools: getTools(includeExternalEmail, includeMaliciousEmail),
      toolChoice: 'auto',
      stopWhen: ({ steps }) => {
        // Stop if we've reached max tool calls
        return stepCountIs(MAX_TOOL_CALLS)({ steps });
      },
    });

    process.stdout.write('\nAssistant: ');

    // Check if any tool calls were made
    const hasToolCalls = response.messages.some((msg) => msg.role === 'tool');

    if (hasToolCalls) {
      // Evaluate the credibility with the full context including new messages
      const fullContext = [...messages, ...response.messages];
      const contextCredibilityEvaluator = new ContextCredibilityEvaluator(
        fullContext,
        STATIC_AUTONOMY_POLICIES,
        MODEL,
        dynamicAutonomyPolicyEvaluatorType
      );

      const evaluation = await contextCredibilityEvaluator.evaluate();

      if (!evaluation.isAllowed) {
        // Block the tool execution
        console.log('\n\n⚠️  TOOL EXECUTION BLOCKED');
        console.log(`Reason: ${evaluation.denyReason}`);
        console.log(
          "\nThe assistant's request was denied due to policy violations.\n"
        );

        // Add a system message indicating the tool was blocked
        messages.push({
          role: 'assistant',
          content:
            'I attempted to use a tool, but it was blocked by security policies.',
        });
        continue;
      }
    }

    // Process and display messages
    for (const message of response.messages) {
      if (message.role === 'assistant') {
        // Handle assistant messages with proper formatting
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
      messages.push(message);
    }
    process.stdout.write('\n\n');
  }
};

cliChatWithGuardrails().catch(console.error);
