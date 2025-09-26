import { google } from '@ai-sdk/google';
import { ModelMessage, generateText, tool } from 'ai';
import { z } from 'zod';

import 'dotenv/config';
import * as readline from 'node:readline/promises';

const MOCK_EMAILS = [
  {
    id: '1',
    subject: 'Hello',
    from: 'matvey@archestra.ai',
    to: 'joey@archestra.ai',
    body: 'Hello, how are you?',
  },
  {
    id: '2',
    subject: '💩💩💩',
    from: 'hackerman@grafana.com',
    to: 'joey@archestra.ai',
    body: "YOU'VE BEEN PWNED",
  },
];

/**
 * Right now this just defines a static object of tools.
 *
 * This would be fetched from the tools of the ACTUAL MCP servers that you have configured for your Archestra
 * enterprise (and for which ones are allowed to be used by this agent (via RBAC access-control policies))
 */
function getDummyTools() {
  return {
    getEmails: tool({
      definition: "Get emails from the user's Gmail inbox",
      inputSchema: z.object({
        count: z.number().optional(),
      }),
      outputSchema: z.object({
        emails: z.array(
          z.object({
            id: z.string(),
            from: z.string(),
            to: z.string(),
            subject: z.string(),
            body: z.string(),
          })
        ),
      }),
      execute: async (args) => ({
        emails: MOCK_EMAILS.slice(0, args.count ?? MOCK_EMAILS.length),
      }),
    }),
    sendTwitterPost: tool({
      definition: 'Send a post to Twitter',
      inputSchema: z.object({
        post: z.string(),
      }),
      outputSchema: z.null(),
      execute: async (args) => {
        console.log('Sent post to Twitter: ', args.post);

        return null;
      },
    }),
  };
}

async function chatWithModel() {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: ModelMessage[] = [];
  const availableTools = getDummyTools();

  while (true) {
    const userInput = await terminal.question('You: ');

    messages.push({ role: 'user', content: userInput });

    const { response } = await generateText({
      model: google('gemini-2.5-flash'),
      messages,
      tools: availableTools,
      toolChoice: 'auto',
    });

    process.stdout.write('\nAssistant: ');
    for (const message of response.messages) {
      process.stdout.write(JSON.stringify(message));
      messages.push(message);
    }
    process.stdout.write('\n\n');

    // let fullResponse = '';
    // process.stdout.write('\nAssistant: ');
    // for await (const delta of response.messages) {
    //   fullResponse += delta;
    //   process.stdout.write(delta);
    // }

    // messages.push({ role: 'assistant', content: fullResponse });
  }
}

chatWithModel().catch(console.error);
