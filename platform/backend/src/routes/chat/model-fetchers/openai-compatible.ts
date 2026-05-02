import logger from "@/logging";

export async function fetchModelsWithBearerAuth<T>(params: {
  url: string;
  apiKey: string;
  errorLabel: string;
  extraHeaders?: Record<string, string> | null;
}): Promise<T> {
  const { url, apiKey, errorLabel, extraHeaders } = params;
  const response = await fetch(url, {
    headers: {
      ...(extraHeaders ?? {}),
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, error: errorText },
      `Failed to fetch ${errorLabel}`,
    );
    throw new Error(`Failed to fetch ${errorLabel}: ${response.status}`);
  }

  return (await response.json()) as T;
}
