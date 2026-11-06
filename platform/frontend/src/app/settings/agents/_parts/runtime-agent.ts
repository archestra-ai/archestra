import type { archestraApiTypes } from "@archestra/shared";

type Dependents =
  archestraApiTypes.GetDefaultModelRuntimeDependentsResponses["200"];

/** An Agent Runtime agent that runs on the organization's default model. */
export type RuntimeAgent = Dependents["agents"][number];

/** The runtime of such an agent, all a caller learns of one it can't read. */
export type RuntimeDependent = Dependents["hidden"][number];

/** A provider key and a model (models.id) chosen for an agent. */
export type ModelSelection = {
  apiKeyId: string | null;
  modelId: string | null;
};
