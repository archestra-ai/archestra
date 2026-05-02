import { type AgentTemplate, archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

export const agentTemplateKeys = {
  all: ["agent-templates"] as const,
  requirements: (id: string) =>
    ["agent-templates", id, "requirements"] as const,
};

export type TemplateRequirements = {
  templateId: string;
  agentConfig: {
    name: string;
    description: string;
    systemPrompt: string;
    llmModel: string | null;
    labels: Array<{ key: string; value: string }>;
    agentType: "agent";
    scope: "personal";
    teams: [];
  };
  toolAssignments: Array<{
    toolId: string;
    catalogId: string | null;
    credentialResolutionMode?: "static" | "dynamic" | "enterprise_managed";
    requiresUserConfig: boolean;
  }>;
  unavailableTools: Array<{
    toolName: string;
    serverName: string;
    reason: "catalog_not_found" | "tool_not_found" | "invalid_tool_name";
  }>;
  missingCatalogs: Array<{
    catalogId: string;
    catalogName: string;
    serverType: "local" | "remote";
    requiresOauth: boolean;
    userConfigFields: Array<{
      key: string;
      type: "string" | "number" | "boolean" | "directory" | "file";
      title: string;
      description: string;
      promptOnInstallation?: boolean;
      required?: boolean;
      default?: string | number | boolean | Array<string>;
      multiple?: boolean;
      sensitive?: boolean;
      min?: number;
      max?: number;
      headerName?: string;
      valuePrefix?: string;
    }>;
    environmentFields: Array<{
      key: string;
      type: "plain_text" | "secret" | "boolean" | "number";
      value?: string;
      promptOnInstallation: boolean;
      required?: boolean;
      description?: string;
      default?: string | number | boolean;
      mounted?: boolean;
    }>;
    canAutoInstall: boolean;
  }>;
};

export function useAgentTemplates(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: agentTemplateKeys.all,
    queryFn: async () => {
      const response = await archestraApiSdk.getAgentTemplates();
      if (response.error) {
        handleApiError(response.error);
        return [];
      }
      return (response.data ?? []) as AgentTemplate[];
    },
    staleTime: 5 * 60 * 1000,
    enabled: options?.enabled,
  });
}

export function useAgentTemplateRequirements(
  templateId: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: agentTemplateKeys.requirements(templateId ?? ""),
    queryFn: async () => {
      if (!templateId) {
        return null;
      }

      const response = await archestraApiSdk.getAgentTemplateRequirements({
        path: { id: templateId },
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }

      return (response.data ?? null) as TemplateRequirements | null;
    },
    enabled: !!templateId && (options?.enabled ?? true),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
}
