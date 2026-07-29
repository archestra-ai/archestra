import type { z } from "zod";
import logger from "@/logging";
import { modelFetchError } from "./types";

interface FetchModelsWithBearerAuthParams {
  url: string;
  apiKey: string;
  errorLabel: string;
  extraHeaders?: Record<string, string> | null;
}

export async function fetchModelsWithBearerAuth<TSchema extends z.ZodType>(
  params: FetchModelsWithBearerAuthParams & { schema: TSchema },
): Promise<z.infer<TSchema>>;
export async function fetchModelsWithBearerAuth<T>(
  params: FetchModelsWithBearerAuthParams,
): Promise<T>;
export async function fetchModelsWithBearerAuth<TSchema extends z.ZodType>(
  params: FetchModelsWithBearerAuthParams & { schema?: TSchema },
): Promise<z.infer<TSchema> | unknown> {
  const { url, apiKey, errorLabel, extraHeaders, schema } = params;
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
    throw modelFetchError(errorLabel, response.status);
  }

  const json = await response.json();
  return schema ? schema.parse(json) : json;
}
