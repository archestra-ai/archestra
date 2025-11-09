/**
 * biome-ignore-all lint/correctness/noEmptyPattern: oddly enough in extend below this is required
 * see https://vitest.dev/guide/test-context.html#extend-test-context
 */
import { type APIRequestContext, test as base } from "@playwright/test";
import { API_BASE_URL, UI_BASE_URL } from "../../consts";

/**
 * Playwright test extension with fixtures
 * https://playwright.dev/docs/test-fixtures#creating-a-fixture
 */
interface TestFixtures {
  makeApiRequest: typeof makeApiRequest;
  createAgent: typeof createAgent;
  deleteAgent: typeof deleteAgent;
  createApiKey: typeof createApiKey;
  deleteApiKey: typeof deleteApiKey;
  createToolInvocationPolicy: typeof createToolInvocationPolicy;
  deleteToolInvocationPolicy: typeof deleteToolInvocationPolicy;
  createTrustedDataPolicy: typeof createTrustedDataPolicy;
  deleteTrustedDataPolicy: typeof deleteTrustedDataPolicy;
}

const makeApiRequest = async ({
  request,
  method,
  urlSuffix,
  data = null,
  headers = {
    "Content-Type": "application/json",
    Origin: UI_BASE_URL,
  },
  ignoreStatusCheck = false,
}: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  headers?: Record<string, string>;
  ignoreStatusCheck?: boolean;
}) => {
  const response = await request[method](`${API_BASE_URL}${urlSuffix}`, {
    headers,
    data,
  });

  if (!ignoreStatusCheck && !response.ok()) {
    throw new Error(
      `Failed to ${method} ${urlSuffix} with data ${JSON.stringify(data)}: ${response.status()} ${await response.text()}`,
    );
  }

  return response;
};

/**
 * Create an agent
 * (authnz is handled by the authenticated session)
 */
const createAgent = async (request: APIRequestContext, name: string) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/agents",
    data: {
      name,
      teams: [],
    },
  });

/**
 * Delete an agent
 * (authnz is handled by the authenticated session)
 */
const deleteAgent = async (request: APIRequestContext, agentId: string) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/agents/${agentId}`,
  });

/**
 * Create an API key
 * (authnz is handled by the authenticated session)
 */
const createApiKey = async (
  request: APIRequestContext,
  name: string = "Test API Key",
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/auth/api-key/create",
    data: {
      name,
      expiresIn: 60 * 60 * 24 * 7, // 1 week
    },
  });

/**
 * Delete an API key by ID
 * (authnz is handled by the authenticated session)
 */
const deleteApiKey = async (request: APIRequestContext, keyId: string) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/auth/api-key/delete",
    data: {
      keyId,
    },
  });

/**
 * Create a tool invocation policy
 * (authnz is handled by the authenticated session)
 */
const createToolInvocationPolicy = async (
  request: APIRequestContext,
  policy: {
    agentToolId: string;
    argumentPath: string;
    operator: string;
    value: string;
    action: "allow_when_context_is_untrusted" | "block_always";
    reason?: string;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/autonomy-policies/tool-invocation",
    data: {
      agentToolId: policy.agentToolId,
      argumentName: policy.argumentPath, // argumentPath maps to argumentName in the schema
      operator: policy.operator,
      value: policy.value,
      action: policy.action,
      reason: policy.reason,
    },
  });

/**
 * Delete a tool invocation policy
 * (authnz is handled by the authenticated session)
 */
const deleteToolInvocationPolicy = async (
  request: APIRequestContext,
  policyId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/autonomy-policies/tool-invocation/${policyId}`,
  });

/**
 * Create a trusted data policy
 * (authnz is handled by the authenticated session)
 */
const createTrustedDataPolicy = async (
  request: APIRequestContext,
  policy: {
    agentToolId: string;
    description: string;
    attributePath: string;
    operator: string;
    value: string;
    action: "block_always" | "mark_as_trusted" | "sanitize_with_dual_llm";
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/trusted-data-policies",
    data: policy,
  });

/**
 * Delete a trusted data policy
 * (authnz is handled by the authenticated session)
 */
const deleteTrustedDataPolicy = async (
  request: APIRequestContext,
  policyId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/trusted-data-policies/${policyId}`,
  });

export * from "@playwright/test";
export const test = base.extend<TestFixtures>({
  makeApiRequest: async ({}, use) => {
    await use(makeApiRequest);
  },
  createAgent: async ({}, use) => {
    await use(createAgent);
  },
  deleteAgent: async ({}, use) => {
    await use(deleteAgent);
  },
  createApiKey: async ({}, use) => {
    await use(createApiKey);
  },
  deleteApiKey: async ({}, use) => {
    await use(deleteApiKey);
  },
  createToolInvocationPolicy: async ({}, use) => {
    await use(createToolInvocationPolicy);
  },
  deleteToolInvocationPolicy: async ({}, use) => {
    await use(deleteToolInvocationPolicy);
  },
  createTrustedDataPolicy: async ({}, use) => {
    await use(createTrustedDataPolicy);
  },
  deleteTrustedDataPolicy: async ({}, use) => {
    await use(deleteTrustedDataPolicy);
  },
});
