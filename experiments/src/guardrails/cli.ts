import {
  SupportedDynamicAutonomyPolicyEvaluators,
  isSupportedDynamicAutonomyPolicyEvaluator,
} from './security/types';

import { ModelMessage, ToolResultPart } from 'ai';

const parseDynamicAutonomyPolicyEvaluatorTypeArg =
  (): SupportedDynamicAutonomyPolicyEvaluators => {
    let dynamicAutonomyPolicyEvaluatorType: SupportedDynamicAutonomyPolicyEvaluators;

    const dynamicAutonomyPolicyEvaluatorTypeArg = process.argv
      .find((arg) => arg === '--dynamic-autonomy-policy-evaluator-type')
      ?.split('=')[1];

    if (
      dynamicAutonomyPolicyEvaluatorTypeArg &&
      !isSupportedDynamicAutonomyPolicyEvaluator(
        dynamicAutonomyPolicyEvaluatorTypeArg
      )
    ) {
      throw new Error(
        'Dynamic autonomy policy evaluator type is not supported'
      );
    } else {
      dynamicAutonomyPolicyEvaluatorType = 'dual-llm';
    }

    return dynamicAutonomyPolicyEvaluatorType;
  };

const printHelp = () => {
  console.log('Usage: pnpm cli-chat-with-guardrails [options]\n');
  console.log('Options:');
  console.log(
    '--dynamic-autonomy-policy-evaluator-type=TYPE - The type of dynamic autonomy policy evaluator to use (default: dual-llm)'
  );
  console.log(
    '--include-external-email - Include external email in mock Gmail data'
  );
  console.log(
    '--include-malicious-email - Include malicious email in mock Gmail data'
  );
  console.log('--debug - Print debug messages');
  console.log('--help - Print this help message');
};

export const prettyPrintAssistantResponseMessages = (
  messages: ModelMessage[],
  debug: boolean
) => {
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
          } else if (content.type === 'tool-call' && debug) {
            process.stdout.write(`\n📞 Calling tool: ${content.toolName}\n`);
            process.stdout.write(
              `   Input: ${JSON.stringify(content.input, null, 2)}\n`
            );
          }
        }
      }
    } else if (message.role === 'tool') {
      if (debug) {
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
      }
    } else {
      // Fallback for other message types
      process.stdout.write(JSON.stringify(message));
    }
  }
};

export const parseArgs = (): {
  dynamicAutonomyPolicyEvaluatorType: SupportedDynamicAutonomyPolicyEvaluators;
  includeExternalEmail: boolean;
  includeMaliciousEmail: boolean;
  debug: boolean;
} => {
  if (process.argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const dynamicAutonomyPolicyEvaluatorType =
    parseDynamicAutonomyPolicyEvaluatorTypeArg();

  return {
    dynamicAutonomyPolicyEvaluatorType,
    includeExternalEmail: process.argv.includes('--include-external-email'),
    includeMaliciousEmail: process.argv.includes('--include-malicious-email'),
    debug: process.argv.includes('--debug'),
  };
};
