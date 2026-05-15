"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  type LimitCleanupInterval,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { LoadingSpinner } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import {
  useOrganization,
  useUpdateLlmSettings,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";

type CompressionScope = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateLlmSettingsData["body"]
  >["compressionScope"]
>;
type UpdateLlmSettingsBody = NonNullable<
  archestraApiTypes.UpdateLlmSettingsData["body"]
>;
type CompressionMode = "disabled" | CompressionScope;

const COMPRESSION_MODE_LABELS: Record<CompressionMode, string> = {
  disabled: "Disabled",
  organization: "Organization level",
  team: "Team level",
};

function formatNumericInput(value: string) {
  if (!value) return "";
  return Number(value).toLocaleString("en-US");
}

export default function LlmSettingsPage() {
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const { data: teams, isPending: areTeamsPending } = useTeams();
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const queryClient = useQueryClient();

  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("disabled");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [hasSyncedInitialSettings, setHasSyncedInitialSettings] =
    useState(false);
  const [defaultUserLimitValue, setDefaultUserLimitValue] = useState("");
  const [defaultUserLimitModels, setDefaultUserLimitModels] = useState<
    string[]
  >([]);
  const [isDefaultUserLimitAllModels, setIsDefaultUserLimitAllModels] =
    useState(true);
  const [defaultUserLimitCleanupInterval, setDefaultUserLimitCleanupInterval] =
    useState<LimitCleanupInterval>(DEFAULT_LIMIT_CLEANUP_INTERVAL);
  const toonDocsUrl = getFrontendDocsUrl(
    "platform-costs-and-limits",
    "toon-compression",
  );

  const updateLlmSettingsMutation = useUpdateLlmSettings(
    "LLM settings updated",
    "Failed to update LLM settings",
  );

  const modelOptions = modelsWithApiKeys.map((model) => ({
    value: model.modelId,
    model: model.modelId,
    provider: model.provider,
    pricePerMillionInput: model.pricePerMillionInput ?? "0",
    pricePerMillionOutput: model.pricePerMillionOutput ?? "0",
  }));

  // Sync state when both organization and teams data are loaded
  useEffect(() => {
    if (!organization || !teams) return;
    if (organization.compressionScope === "organization") {
      setCompressionMode(
        organization.convertToolResultsToToon ? "organization" : "disabled",
      );
    } else {
      // Fall back to "disabled" if scope is "team" but no teams exist
      setCompressionMode(teams.length > 0 ? "team" : "disabled");
    }
    setDefaultUserLimitValue(
      organization.defaultUserLimitValue
        ? String(organization.defaultUserLimitValue)
        : "",
    );
    const defaultModels = Array.isArray(organization.defaultUserLimitModel)
      ? organization.defaultUserLimitModel.filter(
          (model): model is string => typeof model === "string",
        )
      : [];
    setDefaultUserLimitModels(defaultModels);
    setIsDefaultUserLimitAllModels(defaultModels.length === 0);
    setDefaultUserLimitCleanupInterval(
      (organization.defaultUserLimitCleanupInterval as LimitCleanupInterval) ||
        DEFAULT_LIMIT_CLEANUP_INTERVAL,
    );
    const enabledTeams = teams
      .filter((team) => team.convertToolResultsToToon)
      .map((team) => team.id);
    setSelectedTeamIds(enabledTeams);
    setHasSyncedInitialSettings(true);
  }, [organization, teams]);

  const loadedTeams = teams ?? [];

  // Determine if anything has changed from server state
  const serverCompressionMode: CompressionMode =
    organization?.compressionScope === "organization"
      ? organization?.convertToolResultsToToon
        ? "organization"
        : "disabled"
      : loadedTeams.length > 0
        ? "team"
        : "disabled";

  const serverDefaultUserLimitValue = organization?.defaultUserLimitValue
    ? String(organization.defaultUserLimitValue)
    : "";
  const serverDefaultUserLimitModels = Array.isArray(
    organization?.defaultUserLimitModel,
  )
    ? organization.defaultUserLimitModel
        .filter((model): model is string => typeof model === "string")
        .sort()
    : [];
  const serverDefaultUserLimitCleanupInterval =
    (organization?.defaultUserLimitCleanupInterval as LimitCleanupInterval) ||
    DEFAULT_LIMIT_CLEANUP_INTERVAL;

  const serverTeamIds = loadedTeams
    .filter((team) => team.convertToolResultsToToon)
    .map((team) => team.id)
    .sort();

  const hasCompressionChanges =
    compressionMode !== serverCompressionMode ||
    (compressionMode === "team" &&
      JSON.stringify([...selectedTeamIds].sort()) !==
        JSON.stringify(serverTeamIds));

  const hasDefaultUserLimitChanges =
    defaultUserLimitValue !== serverDefaultUserLimitValue ||
    JSON.stringify([...defaultUserLimitModels].sort()) !==
      JSON.stringify(serverDefaultUserLimitModels) ||
    defaultUserLimitCleanupInterval !== serverDefaultUserLimitCleanupInterval;

  const isInitialLoading =
    isOrganizationPending || areTeamsPending || !hasSyncedInitialSettings;
  const hasChanges =
    !isInitialLoading && (hasCompressionChanges || hasDefaultUserLimitChanges);

  const handleSave = async () => {
    const mutations: Promise<unknown>[] = [];
    const llmSettingsBody: UpdateLlmSettingsBody = {};
    let shouldUpdateLlmSettings = false;
    let shouldUpdateTeams = false;

    if (hasCompressionChanges) {
      if (compressionMode === "disabled") {
        Object.assign(llmSettingsBody, {
          compressionScope: "organization",
          convertToolResultsToToon: false,
        });
      } else if (compressionMode === "organization") {
        Object.assign(llmSettingsBody, {
          compressionScope: "organization",
          convertToolResultsToToon: true,
        });
      } else {
        Object.assign(llmSettingsBody, {
          compressionScope: "team",
          convertToolResultsToToon: false,
        });
        shouldUpdateTeams = true;
      }
      shouldUpdateLlmSettings = true;
    }

    if (hasDefaultUserLimitChanges) {
      Object.assign(llmSettingsBody, {
        defaultUserLimitValue: defaultUserLimitValue
          ? Number(defaultUserLimitValue)
          : null,
        defaultUserLimitModel:
          defaultUserLimitValue && !isDefaultUserLimitAllModels
            ? defaultUserLimitModels
            : null,
        defaultUserLimitCleanupInterval: defaultUserLimitValue
          ? defaultUserLimitCleanupInterval
          : null,
      });
      shouldUpdateLlmSettings = true;
    }

    if (shouldUpdateLlmSettings) {
      const updateLlmSettings =
        updateLlmSettingsMutation.mutateAsync(llmSettingsBody);
      mutations.push(
        shouldUpdateTeams
          ? updateLlmSettings
              .then(() =>
                Promise.all(
                  loadedTeams.map((team) =>
                    archestraApiSdk.updateTeam({
                      path: { id: team.id },
                      body: {
                        name: team.name,
                        description: team.description ?? undefined,
                        convertToolResultsToToon: selectedTeamIds.includes(
                          team.id,
                        ),
                      },
                    }),
                  ),
                ),
              )
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ["teams"] }),
              )
          : updateLlmSettings,
      );
    }

    const results = await Promise.allSettled(mutations);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0 && failures.length < results.length) {
      toast.error("Some settings failed to save. Please try again.");
    } else if (failures.length === results.length && failures.length > 0) {
      toast.error("Failed to save settings.");
    }
  };

  const handleCancel = () => {
    setCompressionMode(serverCompressionMode);
    setDefaultUserLimitValue(serverDefaultUserLimitValue);
    setDefaultUserLimitModels(serverDefaultUserLimitModels);
    setIsDefaultUserLimitAllModels(serverDefaultUserLimitModels.length === 0);
    setDefaultUserLimitCleanupInterval(serverDefaultUserLimitCleanupInterval);
    setSelectedTeamIds(
      loadedTeams
        .filter((team) => team.convertToolResultsToToon)
        .map((team) => team.id),
    );
  };

  const handleUnsetDefaultUserLimit = () => {
    setDefaultUserLimitValue("");
    setDefaultUserLimitModels([]);
    setIsDefaultUserLimitAllModels(true);
    setDefaultUserLimitCleanupInterval(DEFAULT_LIMIT_CLEANUP_INTERVAL);
  };

  if (isInitialLoading) {
    return <LoadingSpinner className="my-8" />;
  }

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Apply compression to tool results"
        description={
          <>
            Reduce LLM token usage up to 60% by using TOON (Token-Oriented
            Object Notation) compression for tool results.
            {toonDocsUrl && (
              <>
                {" "}
                <ExternalDocsLink
                  href={toonDocsUrl}
                  className="text-inherit underline underline-offset-4"
                  showIcon={false}
                >
                  Learn how TOON compression works
                </ExternalDocsLink>
                .
              </>
            )}
          </>
        }
        control={
          <WithPermissions
            permissions={{ llmSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={compressionMode}
                onValueChange={(value: CompressionMode) =>
                  setCompressionMode(value)
                }
                disabled={updateLlmSettingsMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(COMPRESSION_MODE_LABELS).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
      >
        {compressionMode === "team" && (
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Select teams</CardTitle>
            {loadedTeams.length === 0 ? (
              <p className="text-sm text-muted-foreground w-48">
                No teams available
              </p>
            ) : (
              <div className="w-48">
                <MultiSelect
                  value={selectedTeamIds}
                  onValueChange={setSelectedTeamIds}
                  placeholder="Select teams..."
                  items={loadedTeams.map((team) => ({
                    value: team.id,
                    label: team.name,
                  }))}
                  disabled={updateLlmSettingsMutation.isPending}
                />
              </div>
            )}
          </div>
        )}
      </SettingsBlock>
      <SettingsBlock
        title="Default user limit"
        description="Apply the same token-cost limit to every existing and future user."
        control={
          serverDefaultUserLimitValue ? (
            <WithPermissions
              permissions={{ llmSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Button
                  variant="outline"
                  onClick={handleUnsetDefaultUserLimit}
                  disabled={
                    updateLlmSettingsMutation.isPending || !hasPermission
                  }
                >
                  Unset
                </Button>
              )}
            </WithPermissions>
          ) : null
        }
      >
        <WithPermissions
          permissions={{ llmSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_12rem_12rem]">
              <div className="space-y-2">
                <Label>Models</Label>
                <LlmModelPicker
                  multiple
                  sortDirection="desc"
                  value={
                    isDefaultUserLimitAllModels
                      ? ["all"]
                      : defaultUserLimitModels
                  }
                  onValueChange={(values) => {
                    const isAllModels = values.includes("all");
                    setDefaultUserLimitModels(isAllModels ? [] : values);
                    setIsDefaultUserLimitAllModels(isAllModels);
                  }}
                  models={modelOptions}
                  editable={
                    hasPermission && !updateLlmSettingsMutation.isPending
                  }
                  includeAllOption
                />
              </div>
              <div className="space-y-2">
                <Label>Limit value ($)</Label>
                <Input
                  value={formatNumericInput(defaultUserLimitValue)}
                  onChange={(event) =>
                    setDefaultUserLimitValue(
                      event.target.value.replace(/[^0-9]/g, ""),
                    )
                  }
                  placeholder="Disabled"
                  inputMode="numeric"
                  disabled={
                    updateLlmSettingsMutation.isPending || !hasPermission
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Cleanup interval</Label>
                <LimitCleanupIntervalSelect
                  value={defaultUserLimitCleanupInterval}
                  onValueChange={setDefaultUserLimitCleanupInterval}
                  disabled={
                    updateLlmSettingsMutation.isPending ||
                    !hasPermission ||
                    !defaultUserLimitValue
                  }
                />
              </div>
            </div>
          )}
        </WithPermissions>
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateLlmSettingsMutation.isPending}
        permissions={{ llmSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}
