import { ModelMessage, generateText, stepCountIs, wrapLanguageModel } from 'ai';

import * as readline from 'node:readline/promises';

import { parseArgs, prettyPrintAssistantResponseMessages } from './cli';
import { contextCredibilityMiddleware } from './middleware';

import config from './config';
import { getTools } from './tools';

import 'dotenv/config';

const {
  model,
  maxToolCalls,
  toolInvocationStaticAutonomyPolicies,
  toolResponseStaticAutonomyPolicies,
} = config;

const cliChatWithGuardrails = async () => {
  const {
    dynamicAutonomyPolicyEvaluatorType,
    includeExternalEmail,
    includeMaliciousEmail,
    debug,
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
        model: model,
        middleware: contextCredibilityMiddleware({
          dynamicEvaluatorType: dynamicAutonomyPolicyEvaluatorType,
        }),
      }),
      messages,
      tools: getTools(
        toolInvocationStaticAutonomyPolicies,
        toolResponseStaticAutonomyPolicies,
        includeExternalEmail,
        includeMaliciousEmail
      ),
      toolChoice: 'auto',
      stopWhen: stepCountIs(maxToolCalls),
    });

    prettyPrintAssistantResponseMessages(newMessages, debug);
    messages.push(...newMessages);

    process.stdout.write('\n\n');
  }
};

cliChatWithGuardrails().catch((error) => {
  console.log('\n\nBye!');
  process.exit(0);
});
