import { APIRequestContext } from '@playwright/test';
import { UI_BASE_URL } from '../consts';

/**
 * Create a tool invocation policy via the UI (which in fact is a redirect that next.js makes to the API)
 */
export async function createToolInvocationPolicy(
  request: APIRequestContext,
  policy: {
    agentToolId: string;
    argumentPath: string;
    operator: string;
    value: string;
    action: 'allow_when_context_is_untrusted' | 'block_always';
    reason?: string;
  },
) {
  const response = await request.post(
    `${UI_BASE_URL}/api/autonomy-policies/tool-invocation`,
    {
      data: {
        agentToolId: policy.agentToolId,
        argumentName: policy.argumentPath, // argumentPath maps to argumentName in the schema
        operator: policy.operator,
        value: policy.value,
        action: policy.action,
        reason: policy.reason,
      },
    },
  );

  if (!response.ok()) {
    throw new Error(
      `Failed to create tool invocation policy: ${response.status()} ${await response.text()}`,
    );
  }

  return response.json();
}

/**
 * Delete a tool invocation policy via the UI (which in fact is a redirect that next.js makes to the API)
 */
export async function deleteToolInvocationPolicy(
  request: APIRequestContext,
  policyId: string,
) {
  const response = await request.delete(
    `${UI_BASE_URL}/api/autonomy-policies/tool-invocation/${policyId}`,
  );

  if (!response.ok()) {
    throw new Error(
      `Failed to delete tool invocation policy: ${response.status()} ${await response.text()}`,
    );
  }

  return response.json();
}
