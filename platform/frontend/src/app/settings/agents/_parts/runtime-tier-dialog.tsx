import type { AgentRuntimeTierSettingsInput } from "@archestra/shared";
import { RuntimeTierEditor } from "@/components/runtime-tiers/runtime-tier-editor";
import {
  type RuntimeTierSize,
  type RuntimeTiersInEffect,
  runtimeTierFormValues,
  runtimeTierSettingsAfter,
} from "@/components/runtime-tiers/runtime-tier-form";
import { RuntimeTierField as Field } from "@/components/runtime-tiers/runtime-tier-resource-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PooledHint } from "./pooled-hint";

export function RuntimeTierDialog({
  open,
  onOpenChange,
  tier,
  tiers,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tier: RuntimeTierSize | null;
  tiers: RuntimeTiersInEffect;
  onSave: (settings: AgentRuntimeTierSettingsInput) => Promise<void>;
}) {
  const isDefault =
    tier !== null &&
    tier.name.toLowerCase() === tiers.defaultTier.toLowerCase();
  return (
    <RuntimeTierEditor
      open={open}
      onOpenChange={onOpenChange}
      originalName={tier?.name ?? null}
      initialValues={runtimeTierFormValues(tier, isDefault)}
      existingNames={tiers.tiers.map((entry) => entry.name)}
      defaultCpuRequest={
        tier?.cpuRequest ??
        tiers.tiers.find((entry) => entry.name === tiers.defaultTier)
          ?.cpuRequest ??
        4
      }
      onSave={(valid, values) =>
        onSave(
          runtimeTierSettingsAfter(
            tiers,
            tier
              ? {
                  kind: "update",
                  original: tier.name,
                  tier: valid,
                  isDefault: values.isDefault,
                }
              : { kind: "create", tier: valid, isDefault: values.isDefault },
          ),
        )
      }
    >
      {({ id, values, update, touch, shown }) => (
        <>
          <Field
            id={`${id}-workspace`}
            label="Disk (GiB)"
            error={shown("workspaceGiB")}
          >
            <Input
              id={`${id}-workspace`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              placeholder={String(tiers.defaultWorkspaceGiB)}
              value={values.workspaceGiB}
              onChange={(event) => update({ workspaceGiB: event.target.value })}
              onBlur={() => touch("workspaceGiB")}
              aria-invalid={shown("workspaceGiB") ? true : undefined}
              aria-describedby={
                shown("workspaceGiB")
                  ? `${id}-workspace-error`
                  : `${id}-workspace-hint`
              }
            />
            <p
              id={`${id}-workspace-hint`}
              className="text-sm text-muted-foreground"
              data-testid="tier-workspace"
            >
              {workspaceHint(tiers.defaultWorkspaceGiB)}
            </p>
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
            <span className="flex items-center gap-1.5">
              <Label htmlFor={`${id}-pooled`} className="font-normal">
                Pooled
              </Label>
              <PooledHint />
            </span>
            <Switch
              id={`${id}-pooled`}
              checked={values.pooled}
              onCheckedChange={(pooled) => update({ pooled })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-default`}
              checked={values.isDefault}
              disabled={isDefault}
              onCheckedChange={(checked) =>
                update({ isDefault: checked === true })
              }
            />
            <Label htmlFor={`${id}-default`} className="font-normal">
              Default tier
            </Label>
          </div>
        </>
      )}
    </RuntimeTierEditor>
  );
}

/** What a blank disk field uses. */
function workspaceHint(defaultWorkspaceGiB: number): string {
  return `${defaultWorkspaceGiB} GiB by default`;
}
