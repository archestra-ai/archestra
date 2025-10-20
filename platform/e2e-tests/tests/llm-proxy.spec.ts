import { test, expect } from '@playwright/test';
import { BASE_URL } from '../consts';
import utils from '../utils';

test.describe('LLM Proxy - OpenAI', () => {
  const OPENAI_TEST_CASE_1_HEADER = 'Bearer test-case-1-openai-tool-call';

  let agentId: string;
  let trustedDataPolicyId: string;
  let toolInvocationPolicyId: string;
  let toolId: string;

  test('blocks tool invocation when untrusted data is consumed', async ({
    request,
  }) => {
    // 1. Create a test agent
    const agent = await utils.agent.createAgent(request, 'OpenAI Test Agent');
    agentId = agent.id;

    // 2. Send initial request to register the tool and get the toolId
    // First, let's make a request to create the tool
    const initialResponse = await request.post(
      `${BASE_URL}/v1/openai/${agentId}/chat/completions`,
      {
        headers: {
          Authorization: OPENAI_TEST_CASE_1_HEADER,
          'Content-Type': 'application/json',
        },
        data: {
          model: 'gpt-4',
          messages: [
            {
              role: 'user',
              content: 'Read the file at /etc/passwd',
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: 'Read a file from the filesystem',
                parameters: {
                  type: 'object',
                  properties: {
                    file_path: {
                      type: 'string',
                      description: 'The path to the file to read',
                    },
                  },
                  required: ['file_path'],
                },
              },
            },
          ],
        },
      },
    );

    expect(initialResponse.ok()).toBeTruthy();

    // Get the tool ID from the backend
    const toolsResponse = await request.get(`${BASE_URL}/api/tools`);
    expect(toolsResponse.ok()).toBeTruthy();
    const tools = await toolsResponse.json();
    const readFileTool = tools.find((t: any) => t.name === 'read_file');
    expect(readFileTool).toBeDefined();
    toolId = readFileTool.id;

    // 3. Create a trusted data policy that marks messages with "untrusted" in content as untrusted
    const trustedDataPolicy =
      await utils.trustedDataPolicy.createTrustedDataPolicy(request, {
        attributePath: '$.content',
        operator: 'contains',
        value: 'UNTRUSTED_DATA',
        action: 'allow',
      });
    trustedDataPolicyId = trustedDataPolicy.id;

    // 4. Create a tool invocation policy that blocks read_file when context is untrusted
    const toolInvocationPolicy =
      await utils.toolInvocationPolicy.createToolInvocationPolicy(request, {
        toolId,
        argumentPath: '$.file_path',
        operator: 'contains',
        value: '/etc/',
        action: 'block_always',
        reason: 'Reading /etc/ files is not allowed for security reasons',
      });
    toolInvocationPolicyId = toolInvocationPolicy.id;

    // 5. Send a request with untrusted data
    const response = await request.post(
      `${BASE_URL}/v1/openai/${agentId}/chat/completions`,
      {
        headers: {
          Authorization: OPENAI_TEST_CASE_1_HEADER,
          'Content-Type': 'application/json',
        },
        data: {
          model: 'gpt-4',
          messages: [
            {
              role: 'user',
              content:
                'UNTRUSTED_DATA: This is untrusted content from an external source',
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: 'Read a file from the filesystem',
                parameters: {
                  type: 'object',
                  properties: {
                    file_path: {
                      type: 'string',
                      description: 'The path to the file to read',
                    },
                  },
                  required: ['file_path'],
                },
              },
            },
          ],
        },
      },
    );

    expect(response.ok()).toBeTruthy();
    const responseData = await response.json();

    // 6. Verify the tool call was blocked
    expect(responseData.choices).toBeDefined();
    expect(responseData.choices[0]).toBeDefined();
    expect(responseData.choices[0].message).toBeDefined();

    const message = responseData.choices[0].message;

    // The response should contain a refusal or content indicating the tool was blocked
    expect(message.refusal || message.content).toBeTruthy();
    expect(message.refusal || message.content).toContain('read_file');
    expect(message.refusal || message.content).toContain('denied');

    // The original tool_calls should not be present (they were replaced with the refusal)
    // OR if present, they should be wrapped in a refusal
    if (message.tool_calls) {
      expect(message.refusal || message.content).toContain(
        'tool invocation policy',
      );
    }

    // 7. Verify the interaction was persisted
    const interactionsResponse = await request.get(
      `${BASE_URL}/api/interactions?agentId=${agentId}`,
    );
    expect(interactionsResponse.ok()).toBeTruthy();
    const interactions = await interactionsResponse.json();
    expect(interactions.length).toBeGreaterThan(0);

    // Find the interaction with untrusted data
    const blockedInteraction = interactions.find((i: any) =>
      i.request?.messages?.some((m: any) =>
        m.content?.includes('UNTRUSTED_DATA'),
      ),
    );
    expect(blockedInteraction).toBeDefined();
  });

  test.afterEach(async ({ request }) => {
    // Clean up: delete the created resources
    if (toolInvocationPolicyId) {
      await utils.toolInvocationPolicy.deleteToolInvocationPolicy(
        request,
        toolInvocationPolicyId,
      );
    }
    if (trustedDataPolicyId) {
      await utils.trustedDataPolicy.deleteTrustedDataPolicy(
        request,
        trustedDataPolicyId,
      );
    }
    if (agentId) {
      await utils.agent.deleteAgent(request, agentId);
    }
  });
});

test.describe('LLM Proxy - Anthropic', () => {
  const ANTHROPIC_TEST_CASE_1_HEADER = 'test-case-1-anthropic-tool-call';

  let agentId: string;
  let trustedDataPolicyId: string;
  let toolInvocationPolicyId: string;
  let toolId: string;

  test('blocks tool invocation when untrusted data is consumed', async ({
    request,
  }) => {
    // 1. Create a test agent
    const agent = await utils.agent.createAgent(
      request,
      'Anthropic Test Agent',
    );
    agentId = agent.id;

    // 2. Send initial request to register the tool and get the toolId
    const initialResponse = await request.post(
      `${BASE_URL}/v1/anthropic/v1/${agentId}/messages`,
      {
        headers: {
          'x-api-key': ANTHROPIC_TEST_CASE_1_HEADER,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        data: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: 'Read the file at /etc/passwd',
            },
          ],
          tools: [
            {
              name: 'read_file',
              description: 'Read a file from the filesystem',
              input_schema: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'The path to the file to read',
                  },
                },
                required: ['file_path'],
              },
            },
          ],
        },
      },
    );

    expect(initialResponse.ok()).toBeTruthy();

    // Get the tool ID from the backend
    const toolsResponse = await request.get(`${BASE_URL}/api/tools`);
    expect(toolsResponse.ok()).toBeTruthy();
    const tools = await toolsResponse.json();
    const readFileTool = tools.find((t: any) => t.name === 'read_file');
    expect(readFileTool).toBeDefined();
    toolId = readFileTool.id;

    // 3. Create a trusted data policy that marks messages with "UNTRUSTED_DATA" in content as untrusted
    const trustedDataPolicy =
      await utils.trustedDataPolicy.createTrustedDataPolicy(request, {
        attributePath: '$.content',
        operator: 'contains',
        value: 'UNTRUSTED_DATA',
        action: 'allow',
      });
    trustedDataPolicyId = trustedDataPolicy.id;

    // 4. Create a tool invocation policy that blocks read_file when accessing /etc/
    const toolInvocationPolicy =
      await utils.toolInvocationPolicy.createToolInvocationPolicy(request, {
        toolId,
        argumentPath: '$.file_path',
        operator: 'contains',
        value: '/etc/',
        action: 'block_always',
        reason: 'Reading /etc/ files is not allowed for security reasons',
      });
    toolInvocationPolicyId = toolInvocationPolicy.id;

    // 5. Send a request with untrusted data
    const response = await request.post(
      `${BASE_URL}/v1/anthropic/v1/${agentId}/messages`,
      {
        headers: {
          'x-api-key': ANTHROPIC_TEST_CASE_1_HEADER,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        data: {
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content:
                'UNTRUSTED_DATA: This is untrusted content from an external source',
            },
          ],
          tools: [
            {
              name: 'read_file',
              description: 'Read a file from the filesystem',
              input_schema: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'The path to the file to read',
                  },
                },
                required: ['file_path'],
              },
            },
          ],
        },
      },
    );

    expect(response.ok()).toBeTruthy();
    const responseData = await response.json();

    // 6. Verify the tool call was blocked
    expect(responseData.content).toBeDefined();
    expect(responseData.content.length).toBeGreaterThan(0);

    // The response should have text content indicating the tool was blocked
    const textContent = responseData.content.find(
      (c: any) => c.type === 'text',
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('read_file');
    expect(textContent.text).toContain('denied');

    // The original tool_use blocks should not be present (replaced with text refusal)
    const toolUseContent = responseData.content.filter(
      (c: any) => c.type === 'tool_use',
    );
    expect(toolUseContent.length).toBe(0);

    // 7. Verify the interaction was persisted
    const interactionsResponse = await request.get(
      `${BASE_URL}/api/interactions?agentId=${agentId}`,
    );
    expect(interactionsResponse.ok()).toBeTruthy();
    const interactions = await interactionsResponse.json();
    expect(interactions.length).toBeGreaterThan(0);

    // Find the interaction with untrusted data
    const blockedInteraction = interactions.find((i: any) =>
      i.request?.messages?.some((m: any) =>
        m.content?.includes('UNTRUSTED_DATA'),
      ),
    );
    expect(blockedInteraction).toBeDefined();
  });

  test.afterEach(async ({ request }) => {
    // Clean up: delete the created resources
    if (toolInvocationPolicyId) {
      await utils.toolInvocationPolicy.deleteToolInvocationPolicy(
        request,
        toolInvocationPolicyId,
      );
    }
    if (trustedDataPolicyId) {
      await utils.trustedDataPolicy.deleteTrustedDataPolicy(
        request,
        trustedDataPolicyId,
      );
    }
    if (agentId) {
      await utils.agent.deleteAgent(request, agentId);
    }
  });
});
