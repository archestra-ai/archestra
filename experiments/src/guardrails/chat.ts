import { ModelMessage, generateText, stepCountIs, wrapLanguageModel } from 'ai';
import * as readline from 'node:readline/promises';
import { v4 as uuidv4 } from 'uuid';

import { parseArgs, prettyPrintAssistantResponseMessages } from './cli';
import config from './config';
import { sessionPersistenceMiddleware } from './middleware';
import { getTools } from './tools';

import 'dotenv/config';

const {
  model,
  maxToolCalls,
  toolInvocationAutonomyPolicies,
  trustedDataAutonomyPolicies,
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

  const sessionId = uuidv4();
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
        middleware: sessionPersistenceMiddleware(sessionId),
      }),
      messages,
      tools: getTools({
        toolInvocationAutonomyPolicies,
        trustedDataAutonomyPolicies,
        includeExternalEmail,
        includeMaliciousEmail,
        sessionId,
        model,
        dynamicEvaluatorType: dynamicAutonomyPolicyEvaluatorType,
        debug,
      }),
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
