import type { archestraApiTypes } from "@archestra/shared";

/** An Agent Runtime agent that runs on the organization's default model. */
export type RuntimeAgent =
  archestraApiTypes.GetDefaultModelRuntimeDependentsResponses["200"]["agents"][number];

/** A provider key and a model (models.id) chosen for an agent. */
export type ModelSelection = {
  apiKeyId: string | null;
  modelId: string | null;
};
