import type { APIRequestContext } from "@playwright/test";

export async function waitForApiEndpointHealthy(params: {
  request: APIRequestContext;
  url: string;
  maxAttempts?: number;
  delayMs?: number;
  description?: string;
}): Promise<void> {
  const maxAttempts = params.maxAttempts ?? 15;
  const delayMs = params.delayMs ?? 2000;
  const description = params.description ?? params.url;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await params.request.get(params.url);
      if (response.ok()) {
        return;
      }

      lastError = new Error(
        `${description} returned ${response.status()} ${response.statusText()}`,
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const suffix =
    lastError instanceof Error
      ? `: ${lastError.message}`
      : lastError
        ? `: ${String(lastError)}`
        : "";
  throw new Error(
    `${description} was not reachable after ${maxAttempts} attempts${suffix}`,
  );
}
