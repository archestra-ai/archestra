import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { type CoreMessage, stepCountIs, streamText, tool } from "ai";
import "dotenv/config";
import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import { z } from "zod";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const conversationHistory: CoreMessage[] = [];

// Default to OpenAI, can be changed via user input
let currentProvider: "openai" | "gemini" = "openai";

async function chat(userMessage: string) {
  conversationHistory.push({
    role: "user",
    content: userMessage,
  });

  const customOpenAI = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "http://localhost:9000/v1/openai", // point requests to Archestra Platform
  }).chat; // Archestra supports Chat Completions API

  const customGemini = createGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "http://localhost:9000/v1/gemini", // point requests to Archestra Platform
  }).chat; // Archestra supports Chat Completions API

  const model =
    currentProvider === "openai"
      ? customOpenAI("gpt-4o-mini")
      : customGemini("gemini-2.5-flash");

  const result = streamText({
    model,
    messages: conversationHistory,
    stopWhen: stepCountIs(5),
    tools: {
      get_file: tool({
        description: "Get the file test.txt.",
        inputSchema: z.object({
          file_path: z.string().describe("The path to the file to get"),
        }),
        execute: async ({ file_path }) => ({
          content: readFileSync(file_path, "utf8"),
        }),
      }),
    },
  });

  process.stdout.write("\nAssistant: ");

  for await (const textPart of result.textStream) {
    process.stdout.write(textPart);
  }

  // Wait for the full result to get all messages including tool calls and tool results
  // This is necessary for Archestra proxy to properly track untrusted data across requests
  const finalResult = await result.response;

  // Add all messages from the AI SDK result to conversation history
  // This includes assistant messages with tool_calls and tool result messages
  conversationHistory.push(...finalResult.messages);

  process.stdout.write("\n\n");
  promptUser();
}

function promptUser() {
  rl.question("You: ", (input) => {
    const message = input.trim();

    if (message.toLowerCase() === "exit" || message.toLowerCase() === "quit") {
      process.stdout.write("Goodbye!\n");
      rl.close();
      process.exit(0);
    }

    // Switch provider
    if (message === "1") {
      currentProvider = "openai";
      process.stdout.write(`\n[Switched to OpenAI]\n\n`);
      promptUser();
      return;
    }

    if (message === "2") {
      currentProvider = "gemini";
      process.stdout.write(`\n[Switched to Gemini]\n\n`);
      promptUser();
      return;
    }

    if (message) {
      chat(message);
    } else {
      promptUser();
    }
  });
}

process.stdout.write(
  'CLI Chat started. Type "exit" or "quit" to end the conversation.\n' +
    'Type "1" for OpenAI or "2" for Gemini to switch providers.\n' +
    `Current provider: ${currentProvider.toUpperCase()}\n\n`,
);
promptUser();
