import type { z } from "zod";
import logger from "@/logging";
import { modelFetchError } from "./types";

interface FetchModelsWithBearerAuthParams {
  url: string;
  apiKey: string;
  errorLabel: string;
  extraHeaders?: Record<string, string> | null;
  /** OAuth-session callers must not replay identity headers across redirects. */
  redirect?: RequestRedirect;
  boundedDiscovery?: boolean;
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
  const {
    url,
    apiKey,
    errorLabel,
    extraHeaders,
    redirect,
    schema,
    boundedDiscovery,
  } = params;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        ...(extraHeaders ?? {}),
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: boundedDiscovery ? "error" : redirect,
      ...(boundedDiscovery ? { signal: AbortSignal.timeout(8000) } : {}),
    });
  } catch (error) {
    if (boundedDiscovery) throw modelFetchError(errorLabel, 502);
    throw error;
  }

  if (boundedDiscovery) {
    if (!response.ok) throw modelFetchError(errorLabel, response.status);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw modelFetchError(errorLabel, 502);
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576) throw modelFetchError(errorLabel, 502);
        chunks.push(chunk);
      }
      const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return schema ? schema.parse(json) : json;
    } catch {
      throw modelFetchError(errorLabel, 502);
    }
  }

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
