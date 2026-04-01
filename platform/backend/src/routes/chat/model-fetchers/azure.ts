import config from "@/config";
import logger from "@/logging";
import type { ModelInfo } from "./types";

export async function fetchAzureModels(
  apiKey: string,
  baseUrlOverride?: string | null,
): Promise<ModelInfo[]> {
  const baseUrl = baseUrlOverride || config.llm.azure.baseUrl;
  if (!baseUrl) {
    return [];
  }

  // Derive the resource endpoint from the deployment baseUrl:
  // https://<resource>.openai.azure.com/openai/deployments/<name>
  //   → https://<resource>.openai.azure.com
  const endpointMatch = baseUrl.match(/^(https?:\/\/[^/]+)/);
  if (!endpointMatch) {
    logger.warn({ baseUrl }, "Could not extract Azure endpoint from baseUrl");
    return [];
  }
  const endpoint = endpointMatch[1];
  const url = `${endpoint}/openai/deployments?api-version=${config.llm.azure.apiVersion}`;

  try {
    const response = await fetch(url, {
      headers: { "api-key": apiKey },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        { status: response.status, error: errorText },
        "Failed to fetch Azure deployments",
      );
      return [];
    }

    const data = (await response.json()) as { data?: { id: string }[] };
    return (data.data ?? []).map((dep) => ({
      id: dep.id,
      displayName: dep.id,
      provider: "azure" as const,
    }));
  } catch (error) {
    logger.error({ error }, "Error fetching Azure deployments");
    return [];
  }
}
