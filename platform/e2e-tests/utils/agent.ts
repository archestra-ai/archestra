import { APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../consts';

/**
 * Create an agent via the API
 */
export async function createAgent(request: APIRequestContext, name: string) {
  const response = await request.post(`${BASE_URL}/api/agents`, {
    data: {
      name,
      teams: [],
    },
  });

  if (!response.ok()) {
    throw new Error(
      `Failed to create agent: ${response.status()} ${await response.text()}`,
    );
  }

  return response.json();
}

/**
 * Delete an agent via the API
 */
export async function deleteAgent(request: APIRequestContext, agentId: string) {
  const response = await request.delete(`${BASE_URL}/api/agents/${agentId}`);

  if (!response.ok()) {
    throw new Error(
      `Failed to delete agent: ${response.status()} ${await response.text()}`,
    );
  }

  return response.json();
}
