import type {
  McpRuntimeTierSettingsInput,
  McpRuntimeTierSize,
} from "@archestra/shared";
import { RuntimeTierEditor } from "@/components/runtime-tiers/runtime-tier-editor";
import { runtimeTierFormValues } from "@/components/runtime-tiers/runtime-tier-form";
import { mcpRuntimeTierInput } from "./mcp-runtime-tier-form";

export function McpRuntimeTierDialog({
  open,
  onOpenChange,
  tier,
  tiers,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tier: McpRuntimeTierSize | null;
  tiers: { tiers: McpRuntimeTierSize[] };
  onSave: (settings: McpRuntimeTierSettingsInput) => Promise<void>;
}) {
  return (
    <RuntimeTierEditor
      open={open}
      onOpenChange={onOpenChange}
      originalName={tier?.name ?? null}
      initialValues={runtimeTierFormValues(
        tier
          ? { ...tier, pooled: false, warmSpares: 0, workspaceGiB: null }
          : null,
        false,
      )}
      existingNames={tiers.tiers.map((entry) => entry.name)}
      defaultCpuRequest={tier?.cpuRequest ?? 1}
      onSave={(valid) => {
        const saved = {
          name: valid.name,
          cpuRequest: valid.cpuRequest,
          cpuLimit: valid.cpuLimit,
          memoryRequestMiB: valid.memoryRequestMiB,
          memoryLimitMiB: valid.memoryLimitMiB,
        };
        return onSave({
          tiers: tier
            ? tiers.tiers.map((entry) =>
                entry.name === tier.name
                  ? { ...saved, previousName: tier.name }
                  : mcpRuntimeTierInput(entry),
              )
            : [...tiers.tiers.map(mcpRuntimeTierInput), saved],
        });
      }}
    />
  );
}
