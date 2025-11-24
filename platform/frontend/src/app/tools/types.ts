import type { archestraApiTypes } from "@shared";

export type Tool = archestraApiTypes.GetToolsResponses["200"]["data"][number];

export type ToolPolicy =
  archestraApiTypes.GetToolPoliciesForToolResponses["200"][number];
export type ToolPolicyResultTreatmentOption = ToolPolicy["toolResultTreatment"];

export type ToolInvocationPolicy = ToolPolicy["toolInvocationPolicies"][number];
export type TrustedDataPolicy = ToolPolicy["trustedDataPolicies"][number];
