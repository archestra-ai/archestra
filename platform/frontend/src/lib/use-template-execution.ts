import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useCreateProfile, useDeleteProfile } from "@/lib/agent.query";
import type { TemplateRequirements } from "@/lib/agent-templates.query";
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { useInstallMcpServer } from "@/lib/mcp/mcp-server.query";

type ManualCatalogInstallData = {
  scope: "personal";
  userConfigValues?: Record<string, string>;
  environmentValues?: Record<string, string>;
  isByosVault?: boolean;
  serviceAccount?: string;
};

export type TemplateExecutionParams = {
  requirements: TemplateRequirements;
  formValues: Record<string, string>;
  onOpenChange: (open: boolean) => void;
};

export function useTemplateExecution() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const createProfile = useCreateProfile();
  const deleteProfile = useDeleteProfile();
  const bulkAssignTools = useBulkAssignTools();
  const installMcpServer = useInstallMcpServer();
  const orchestrator = useMcpInstallOrchestrator();

  async function execute(params: TemplateExecutionParams) {
    const { requirements, formValues, onOpenChange } = params;
    let createdAgentId: string | null = null;
    const progressId = "template-progress";

    try {
      toast.loading("Creating agent...", { id: progressId });

      const createdAgent = await createProfile.mutateAsync(
        requirements.agentConfig as archestraApiTypes.CreateAgentData["body"],
      );
      if (!createdAgent?.id) {
        return;
      }
      createdAgentId = createdAgent.id;

      const serverIds = new Map<string, string>();
      let provisioningComplete = true;

      for (const catalog of requirements.missingCatalogs.filter(
        (entry) => entry.canAutoInstall,
      )) {
        toast.loading(`Installing ${catalog.catalogName}...`, {
          id: progressId,
        });
        try {
          const result = await installMcpServer.mutateAsync({
            name: catalog.catalogName,
            catalogId: catalog.catalogId,
            scope: "personal",
            agentIds: [createdAgent.id],
            dontShowToast: true,
          });
          if (result.installedServer?.id) {
            serverIds.set(
              result.installedServer.catalogId ?? catalog.catalogId,
              result.installedServer.id,
            );
          } else {
            provisioningComplete = false;
            toast.warning(`Failed to auto-install ${catalog.catalogName}`, {
              id: progressId,
            });
          }
        } catch {
          provisioningComplete = false;
          toast.warning(`Failed to auto-install ${catalog.catalogName}`, {
            id: progressId,
          });
        }
      }

      for (const catalog of requirements.missingCatalogs.filter(
        (entry) => !entry.canAutoInstall,
      )) {
        const installData = buildManualInstallData(catalog, formValues);
        toast.loading(`Setting up ${catalog.catalogName}...`, {
          id: progressId,
        });
        const result = await orchestrator.triggerInstallByCatalogIdAndWait({
          catalogId: catalog.catalogId,
          installationData: { ...installData, agentIds: [createdAgent.id] },
        });

        if (result.installedServerId) {
          serverIds.set(catalog.catalogId, result.installedServerId);
        }

        if (!result.completed) {
          provisioningComplete = false;
          toast.warning(
            `Provisioning for ${catalog.catalogName} needs follow-up`,
            { id: progressId },
          );
        }
      }

      toast.loading("Assigning tools...", { id: progressId });

      const resolvedRequirements = await refetchTemplateRequirements(
        requirements.templateId,
      );

      const missingCatalogIds = new Set<string>();
      for (const c of requirements.missingCatalogs) {
        missingCatalogIds.add(c.catalogId);
      }

      const staleCatalogIds = new Set<string>();
      for (const a of resolvedRequirements.toolAssignments) {
        if (a.catalogId && !missingCatalogIds.has(a.catalogId)) {
          staleCatalogIds.add(a.catalogId);
        }
      }

      if (staleCatalogIds.size > 0) {
        const allServers = (await archestraApiSdk.getMcpServers())?.data ?? [];
        for (const catalogId of staleCatalogIds) {
          const server = allServers.find((s) => s.catalogId === catalogId);
          if (server?.id) {
            serverIds.set(catalogId, server.id);
          }
        }
      }

      const assignments = resolvedRequirements.toolAssignments.map(
        (assignment) => ({
          agentId: createdAgent.id,
          toolId: assignment.toolId,
          mcpServerId: assignment.catalogId
            ? (serverIds.get(assignment.catalogId) ?? null)
            : null,
          ...(assignment.credentialResolutionMode
            ? {
                credentialResolutionMode: assignment.credentialResolutionMode,
              }
            : {}),
          ...(assignment.credentialResolutionMode === "static"
            ? {}
            : { resolveAtCallTime: true }),
        }),
      );

      if (
        requirements.templateId !== "general-purpose" &&
        assignments.length === 0
      ) {
        toast.error("Template tools could not be installed", {
          id: progressId,
        });
        throw new Error("Template tools could not be installed");
      }

      if (assignments.length > 0) {
        try {
          const result = await bulkAssignTools.mutateAsync({ assignments });
          if (!result || result.failed.length > 0) {
            toast.error("Failed to assign template tools", {
              id: progressId,
            });
            throw new Error("Failed to assign template tools");
          }
        } catch {
          toast.error("Failed to assign template tools", {
            id: progressId,
          });
          throw new Error("Failed to assign template tools");
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(`${requirements.agentConfig.name} created`, {
        id: progressId,
      });
      router.push(provisioningComplete ? "/chat" : "/agents");
      onOpenChange(false);
    } catch {
      if (createdAgentId) {
        await deleteProfile.mutateAsync(createdAgentId);
      }
    }
  }

  return { execute, orchestrator };
}

async function refetchTemplateRequirements(templateId: string) {
  const response = await archestraApiSdk.getAgentTemplateRequirements({
    path: { id: templateId },
  });
  return response.data as TemplateRequirements;
}

function buildManualInstallData(
  catalog: TemplateRequirements["missingCatalogs"][number],
  values: Record<string, string>,
): ManualCatalogInstallData {
  const userConfigValues = collectUserConfigValues(catalog, values);
  const environmentValues = collectEnvironmentValues(catalog, values);

  return {
    scope: "personal",
    ...(Object.keys(userConfigValues).length > 0 ? { userConfigValues } : {}),
    ...(Object.keys(environmentValues).length > 0 ? { environmentValues } : {}),
  };
}

function collectUserConfigValues(
  catalog: TemplateRequirements["missingCatalogs"][number],
  values: Record<string, string>,
) {
  return Object.fromEntries(
    catalog.userConfigFields
      .map(
        (field) =>
          [
            field.key,
            values[
              buildFormKey(catalog.catalogId, "userConfig", field.key)
            ]?.trim(),
          ] as const,
      )
      .filter(([, value]) => Boolean(value)),
  );
}

function collectEnvironmentValues(
  catalog: TemplateRequirements["missingCatalogs"][number],
  values: Record<string, string>,
) {
  return Object.fromEntries(
    catalog.environmentFields
      .map(
        (field) =>
          [
            field.key,
            values[
              buildFormKey(catalog.catalogId, "environment", field.key)
            ]?.trim(),
          ] as const,
      )
      .filter(([, value]) => Boolean(value)),
  );
}

function buildFormKey(
  catalogId: string,
  source: "userConfig" | "environment",
  key: string,
) {
  return `${catalogId}::${source}::${key}`;
}
