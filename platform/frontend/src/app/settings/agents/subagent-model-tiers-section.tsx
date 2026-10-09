"use client";

import {
  type archestraApiTypes,
  FAST_MODEL_PATTERNS,
  findFirstModelByPatterns,
  type SupportedProvider,
} from "@archestra/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { type LlmModel, useLlmModelsByProvider } from "@/lib/llm-models.query";
import {
  useOrganization,
  useUpdateAgentSettings,
} from "@/lib/organization.query";

type SubagentModelTiers = NonNullable<
  archestraApiTypes.UpdateAgentSettingsData["body"]["subagentModelTiers"]
>;
type Tier = "fast" | "smart";

const DEFAULT_VALUE = "all";

/**
 * Which model a forked subagent runs on when its parent asks for the `fast` or
 * `smart` tier, per provider. A fork stays on its parent's provider key, so
 * each provider gets its own pair; unset tiers use the provider default.
 */
export function SubagentModelTiersSection() {
  const { data: organization } = useOrganization();
  const { modelsByProvider } = useLlmModelsByProvider();
  const providerCatalog = useModelProviderCatalog();
  const updateMutation = useUpdateAgentSettings(
    "Subagent model tiers updated",
    "Failed to update subagent model tiers",
  );

  const saved = organization?.subagentModelTiers ?? {};
  const savedKey = tiersKey(saved);
  const [tiers, setTiers] = useState<SubagentModelTiers>(saved);
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (lastSavedKey.current === savedKey) return;
    const previousSavedKey = lastSavedKey.current;
    lastSavedKey.current = savedKey;
    setTiers((current) =>
      tiersKey(current) === previousSavedKey ? saved : current,
    );
  }, [savedKey, saved]);

  const providers = useMemo(
    () =>
      (Object.keys(modelsByProvider) as SupportedProvider[])
        .filter((provider) => toolCapable(modelsByProvider[provider]).length)
        .sort((a, b) =>
          providerCatalog.label(a).localeCompare(providerCatalog.label(b)),
        ),
    [modelsByProvider, providerCatalog],
  );

  const setTier = (provider: SupportedProvider, tier: Tier, value: string) =>
    setTiers((current) => {
      const { [tier]: _, ...rest } = current[provider] ?? {};
      const next = value === DEFAULT_VALUE ? rest : { ...rest, [tier]: value };
      const { [provider]: __, ...others } = current;
      return Object.keys(next).length
        ? { ...others, [provider]: next }
        : others;
    });

  if (!organization || providers.length === 0) return null;

  return (
    <>
      <SettingsBlock
        id="subagent-model-tiers"
        title="Subagent Model Tiers"
        description="When an agent forks itself, it can run the copy on a smarter or faster model from the same provider. Default uses the provider's best model for Smart and its small model for Fast."
        control={null}
      >
        <WithPermissions
          permissions={{ organizationSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <div className="flex flex-col gap-3">
              {providers.map((provider) => {
                const models = toolCapable(modelsByProvider[provider]);
                return (
                  <div
                    key={provider}
                    className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr] sm:items-center"
                  >
                    <span className="text-sm font-medium">
                      {providerCatalog.label(provider)}
                    </span>
                    {(["fast", "smart"] as const).map((tier) => (
                      <LlmModelSearchableSelect
                        key={tier}
                        value={tiers[provider]?.[tier] ?? DEFAULT_VALUE}
                        onValueChange={(value) =>
                          setTier(provider, tier, value)
                        }
                        options={models.map((model) => ({
                          value: model.dbId,
                          model: model.displayName ?? model.id,
                          modelId: model.id,
                          provider: model.provider,
                          isBest: model.isBest,
                        }))}
                        includeAllOption
                        allLabel={`${TIER_LABELS[tier]}: ${defaultLabel(provider, tier, models)}`}
                        className="w-full"
                        disabled={updateMutation.isPending || !hasPermission}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </WithPermissions>
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={tiersKey(tiers) !== savedKey}
        isSaving={updateMutation.isPending}
        disabledSave={!organization}
        permissions={{ organizationSettings: ["update"] }}
        onSave={() => updateMutation.mutateAsync({ subagentModelTiers: tiers })}
        onCancel={() => setTiers(saved)}
      />
    </>
  );
}

const TIER_LABELS: Record<Tier, string> = { fast: "Fast", smart: "Smart" };

function tiersKey(tiers: SubagentModelTiers): string {
  return JSON.stringify(
    Object.entries(tiers)
      .map(([provider, tier]) => [provider, tier?.fast, tier?.smart])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

function toolCapable(models: LlmModel[] | undefined): LlmModel[] {
  return (models ?? []).filter(
    (model) => model.capabilities?.supportsToolCalling !== false,
  );
}

function defaultLabel(
  provider: SupportedProvider,
  tier: Tier,
  models: LlmModel[],
): string {
  const model =
    tier === "smart"
      ? models.find((m) => m.isBest)
      : findFirstModelByPatterns(
          models.map((m) => ({ ...m, modelId: m.id })),
          FAST_MODEL_PATTERNS[provider] ?? [],
        );
  return model
    ? `default (${model.displayName ?? model.id})`
    : "same as parent";
}
