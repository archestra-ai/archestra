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

  let sessionId = uuidv4();
  let messages: ModelMessage[] = [];

  console.log('Type /help to see the available commands');
  console.log('Type /exit to exit');
  console.log('Type /new to start a new session\n');

  while (true) {
    const userInput = await terminal.question('You: ');

    if (userInput === '/help') {
      console.log('Available commands:');
      console.log('/help - Show this help message');
      console.log('/exit - Exit the program');
      console.log('/new - Start a new session');
      console.log('\n');
      continue;
    } else if (userInput === '/exit') {
      console.log('Exiting...');
      process.exit(0);
    } else if (userInput === '/new') {
      console.log('Starting a new session...\n');
      sessionId = uuidv4();
      messages = [];
      continue;
    }

    messages.push({ role: 'user', content: userInput });

    const {
      response: { messages: newMessages },
    } = await generateText({
      system: `If the user asks you to read a directory, or file, it should be relative to ~.

      Some examples:
      - if the user asks you to read Desktop/file.txt, you should read ~/Desktop/file.txt.
      - if the user asks you to read Desktop, you should read ~/Desktop.
      `,
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

    prettyPrintAssistantResponseMessages(newMessages);
    messages.push(...newMessages);

    process.stdout.write('\n\n');
  }
};

cliChatWithGuardrails().catch((error) => {
  console.log('\n\nBye!');
  process.exit(0);
});
