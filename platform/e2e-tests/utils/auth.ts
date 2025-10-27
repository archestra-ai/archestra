import { APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../consts';

/**
 * Create an API key for testing using the authenticated session
 */
export const createApiKey = async (
  request: APIRequestContext,
  name: string = 'Test API Key'
): Promise<{ id: string; key: string }> => {
  const response = await request.post(`${API_BASE_URL}/api/auth/api-key/create`, {
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'http://localhost:3000',
    },
    data: {
      name,
      expiresIn: 60 * 60 * 24 * 7, // 1 week
    },
  });

  if (!response.ok()) {
    throw new Error(
      `Failed to create API key: ${response.status()} ${await response.text()}`
    );
  }

  const result = await response.json();
  return {
    id: result.id,
    key: result.key,
  };
};

/**
 * Delete an API key by ID using the authenticated session
 */
export const deleteApiKey = async (
  request: APIRequestContext,
  keyId: string
): Promise<void> => {
  const response = await request.post(`${API_BASE_URL}/api/auth/api-key/delete`, {
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'http://localhost:3000',
    },
    data: {
      keyId,
    },
  });

  if (!response.ok()) {
    throw new Error(
      `Failed to delete API key: ${response.status()} ${await response.text()}`
    );
  }
};
