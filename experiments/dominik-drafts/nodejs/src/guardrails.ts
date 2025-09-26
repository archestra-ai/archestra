// @ts-nocheck

import { google } from '@ai-sdk/google';
import { ModelMessage, ToolResultPart, generateText, tool } from 'ai';
import { z } from 'zod';

import 'dotenv/config';
import * as readline from 'node:readline/promises';

type StaticAutonomyPolicy = {
  mcpServerName: string;
  toolName: string;
  description: string;
  attribute: string;
  operator:
    | 'equal'
    | 'notEqual'
    | 'contains'
    | 'notContains'
    | 'startsWith'
    | 'endsWith';
  value: string;
  allow: boolean;
};

type StaticAutonomyPolicyEvaluatorResult = {
  isAllowed: boolean;
  denyReason: string;
};

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

const GMAIL_READ_EMAIL_TOOL_ID = 'gmail__readEmail';
const TWITTER_SEND_POST_TOOL_ID = 'twitter__sendPost';

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

class StaticAutonomyPolicyEvaluator {
  private context: ModelMessage[];
  private policies: AutonomyPolicy[];

  constructor(context: ModelMessage[], policies: AutonomyPolicy[]) {
    this.context = context;
    this.policies = policies;
  }

  private endsWithEvaluator(
    message: ModelMessage,
    policy: AutonomyPolicy
  ): StaticAutonomyPolicyEvaluatorResult {
    const isAllowed = message.content.endsWith(policy.value);
    return {
      isAllowed,
      denyReason: isAllowed ? '' : policy.description,
    };
  }

  private startsWithEvaluator(
    message: ModelMessage,
    policy: AutonomyPolicy
  ): StaticAutonomyPolicyEvaluatorResult {
    const isAllowed = message.content.startsWith(policy.value);
    return {
      isAllowed,
      denyReason: isAllowed ? '' : policy.description,
    };
  }

  private containsEvaluator(
    message: ModelMessage,
    policy: AutonomyPolicy
  ): StaticAutonomyPolicyEvaluatorResult {
    const isAllowed = message.content.includes(policy.value);
    return {
      isAllowed,
      denyReason: isAllowed ? '' : policy.description,
    };
  }

  private notContainsEvaluator(
    message: ModelMessage,
    policy: AutonomyPolicy
  ): StaticAutonomyPolicyEvaluatorResult {
    const isAllowed = !message.content.includes(policy.value);
    return {
      isAllowed,
      denyReason: isAllowed ? '' : policy.description,
    };
  }

  private equalEvaluator(
    message: ModelMessage,
    policy: AutonomyPolicy
  ): StaticAutonomyPolicyEvaluatorResult {
    const isAllowed = message.content === policy.value;
    return {
      isAllowed,
      denyReason: isAllowed ? '' : policy.description,
    };
  }

  private notEqualEvaluator(
    message: ModelMessage,
    policy: AutonomyPolicy
  ): StaticAutonomyPolicyEvaluatorResult {
    const isAllowed = message.content !== policy.value;
    return {
      isAllowed,
      denyReason: isAllowed ? '' : policy.description,
    };
  }

  evaluate() {
    let evaluationResult: StaticAutonomyPolicyEvaluatorResult = {
      isAllowed: true,
      denyReason: '',
    };

    const toolCallResults: ToolResultPart[] = this.context
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.content[0]);

    for (const toolCallResult of toolCallResults) {
      let valueToCheck: string | null = null;

      if (toolCallResult.toolCallId === GMAIL_READ_EMAIL_TOOL_ID) {
        valueToCheck = toolCallResult.output?.value?.emails;
      } else if (toolCallResult.toolCallId === TWITTER_SEND_POST_TOOL_ID) {
        valueToCheck = toolCallResult.output.value.post;
      }

      for (const policy of this.policies) {
        switch (policy.operator) {
          case 'endsWith':
            evaluationResult = this.endsWithEvaluator(message, policy);
            break;
          case 'startsWith':
            evaluationResult = this.startsWithEvaluator(message, policy);
            break;
          case 'contains':
            evaluationResult = this.containsEvaluator(message, policy);
            break;
          case 'notContains':
            evaluationResult = this.notContainsEvaluator(message, policy);
            break;
          case 'equal':
            evaluationResult = this.equalEvaluator(message, policy);
            break;
          case 'notEqual':
            evaluationResult = this.notEqualEvaluator(message, policy);
            break;
        }
      }
    }

    return {
      isAllowed,
      denyReason,
    };
  }
}

class DynamicAutonomyPolicyEvaluator {
  private context: ModelMessage[];

  constructor(context: ModelMessage[]) {
    this.context = context;
  }

  /**
   * TODO: add LLM based evaluation here (ex. "dual LLMs" strategy)
   */
  evaluate() {
    return {
      isAllowed: true,
      denyReason: '',
    };
  }
}

class ContextCredibilityEvaluator {
  private staticAutonomyPolicyEvaluator: StaticAutonomyPolicyEvaluator;
  private dynamicAutonomyPolicyEvaluator: DynamicAutonomyPolicyEvaluator;

  constructor(
    context: ModelMessage[],
    staticAutonomyPolicies: StaticAutonomyPolicy[]
  ) {
    this.staticAutonomyPolicyEvaluator = new StaticAutonomyPolicyEvaluator(
      context,
      staticAutonomyPolicies
    );
    this.dynamicAutonomyPolicyEvaluator = new DynamicAutonomyPolicyEvaluator(
      context
    );
  }

  evaluate() {
    const { isAllowed: isAllowedStatic, denyReason: denyReasonStatic } =
      this.staticAutonomyPolicyEvaluator.evaluate();
    const { isAllowed: isAllowedDynamic, denyReason: denyReasonDynamic } =
      this.dynamicAutonomyPolicyEvaluator.evaluate();

    return {
      isAllowed: isAllowedStatic && isAllowedDynamic,
      denyReason: denyReasonStatic || denyReasonDynamic,
    };
  }
}

/**
 * Right now this just defines a static object of tools.
 *
 * This would be fetched from the tools of the ACTUAL MCP servers that you have configured for your Archestra
 * enterprise (and for which ones are allowed to be used by this agent (via RBAC access-control policies))
 */
function getDummyTools() {
  return {
    [GMAIL_READ_EMAIL_TOOL_ID]: tool({
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
    [TWITTER_SEND_POST_TOOL_ID]: tool({
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
  const contextIsCredible = true;

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
      if (message.role === 'tool') {
        const toolCallResult = message.content[0];

        // TODO:
      }

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
