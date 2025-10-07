import { createOpenAI } from '@ai-sdk/openai';
import { streamText, CoreMessage } from 'ai';
import 'dotenv/config';
import * as readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const conversationHistory: CoreMessage[] = [];

async function chat(userMessage: string) {
  conversationHistory.push({
    role: 'user',
    content: userMessage,
  });

  const customOpenAI = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "http://localhost:9000/v1", // point requests to Archestra Platform
  }).chat; // Archestra supports Chat Completions API

  const result = streamText({
    model: customOpenAI('gpt-4o'),
    messages: conversationHistory,
  });

  process.stdout.write('\nAssistant: ');

  let fullResponse = '';
  for await (const textPart of result.textStream) {
    process.stdout.write(textPart);
    fullResponse += textPart;
  }

  conversationHistory.push({
    role: 'assistant',
    content: fullResponse,
  });

  process.stdout.write('\n\n');
  promptUser();
}

function promptUser() {
  rl.question('You: ', (input) => {
    const message = input.trim();

    if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit') {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }

    if (message) {
      chat(message);
    } else {
      promptUser();
    }
  });
}

console.log('CLI Chat started. Type "exit" or "quit" to end the conversation.\n');
promptUser();
