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

async function chat(userMessage: string) {
  conversationHistory.push({
    role: "user",
    content: userMessage,
  });

  const customOpenAI = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "http://localhost:9000/v1/openai", // point requests to Archestra Platform
  }).chat; // Archestra supports Chat Completions API

  const result = streamText({
    model: customOpenAI("gpt-4o"),
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
      console.log("Goodbye!");
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

console.log(
  'CLI Chat started. Type "exit" or "quit" to end the conversation.\n',
);
promptUser();
