import { APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../consts';

/**
 * Create a trusted data policy via the API
 */
export async function createTrustedDataPolicy(
  request: APIRequestContext,
  policy: {
    agentToolId: string;
    description: string;
    attributePath: string;
    operator: string;
    value: string;
    action: 'block_always' | 'mark_as_trusted' | 'sanitize_with_dual_llm';
  },
) {
  const response = await request.post(`${BASE_URL}/api/trusted-data-policies`, {
    data: policy,
  });

  if (!response.ok()) {
    throw new Error(
      `Failed to create trusted data policy: ${response.status()} ${await response.text()}`,
    );
  }

  return response.json();
}

/**
 * Delete a trusted data policy via the API
 */
export async function deleteTrustedDataPolicy(
  request: APIRequestContext,
  policyId: string,
) {
  const response = await request.delete(
    `${BASE_URL}/api/trusted-data-policies/${policyId}`,
  );

  if (!response.ok()) {
    throw new Error(
      `Failed to delete trusted data policy: ${response.status()} ${await response.text()}`,
    );
  }

  return response.json();
}
