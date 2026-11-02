import type { SupportedProvider } from "@archestra/shared/model-constants";
import { modelsDevClient } from "@/clients/models-dev-client";
import ModelModel from "@/models/model";

/** A pinned shorthand is rewritten on the wire as well as for policy checks. */
export async function resolveFireworksModel(params: {
  provider: SupportedProvider;
  model: string;
  baseUrl: string | undefined;
}): Promise<{ model: string; unresolved: boolean }> {
  const { provider, model, baseUrl } = params;
  if (!isFireworksEndpoint(baseUrl)) return { model, unresolved: false };
  if (/^accounts\/[^/]+\/models\/[^/#]+$/.test(model))
    return { model, unresolved: false };
  // Deployments are explicitly selected resources, not serverless aliases.
  if (/^accounts\/[^/]+\/deployments\/[^/]+$/.test(model))
    return { model, unresolved: false };
  if (/^[a-zA-Z0-9._-]+$/.test(model) && model !== "auto") {
    const canonical = `accounts/fireworks/models/${model}`;
    const row = await ModelModel.findByProviderAndModelId(provider, canonical);
    const registered =
      row ??
      (await modelsDevClient.fetchModelsFromApi().catch(() => null))?.[
        "fireworks-ai"
      ]?.models[canonical];
    if (registered) return { model: canonical, unresolved: false };
  }
  return { model, unresolved: true };
}

/** Pinned spellings of an already selected Fireworks model, never router names. */
export function fireworksModelAliases(model: string): string[] {
  const match = /^accounts\/fireworks\/models\/([a-zA-Z0-9._-]+)$/.exec(model);
  return match && match[1] !== "auto" ? [match[1]] : [];
}

/** Only the documented Fireworks inference origin establishes billing identity. */
export function isFireworksEndpoint(
  baseUrl: string | null | undefined,
): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.fireworks.ai" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/inference(?:\/v1)?\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
