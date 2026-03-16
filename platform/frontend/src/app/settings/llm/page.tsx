"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { CardTitle } from "@/components/ui/card";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useOrganization,
  useUpdateLlmSettings,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/team.query";

type LimitCleanupInterval = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateLlmSettingsData["body"]
  >["limitCleanupInterval"]
>;

const CLEANUP_INTERVAL_LABELS: Record<LimitCleanupInterval, string> = {
  "1h": "Every hour",
  "12h": "Every 12 hours",
  "24h": "Every 24 hours",
  "1w": "Every week",
  "1m": "Every month",
};

type CompressionScope = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateLlmSettingsData["body"]
  >["compressionScope"]
>;
type CompressionMode = "disabled" | CompressionScope;

const COMPRESSION_MODE_LABELS: Record<CompressionMode, string> = {
  disabled: "Disabled",
  organization: "Organization level",
  team: "Team level",
};

export default function LlmSettingsPage() {
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const { data: teams, isPending: areTeamsPending } = useTeams();
  const queryClient = useQueryClient();

  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("disabled");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [cleanupInterval, setCleanupInterval] =
    useState<LimitCleanupInterval>("1h");

  const updateLlmSettingsMutation = useUpdateLlmSettings(
    "LLM settings updated",
    "Failed to update LLM settings",
  );

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
    setCleanupInterval(
      (organization.limitCleanupInterval as LimitCleanupInterval) || "1h",
    );
    const enabledTeams = teams
      .filter((team) => team.convertToolResultsToToon)
      .map((team) => team.id);
    setSelectedTeamIds(enabledTeams);
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

  const serverCleanupInterval =
    (organization?.limitCleanupInterval as LimitCleanupInterval) || "1h";

  const serverTeamIds = loadedTeams
    .filter((team) => team.convertToolResultsToToon)
    .map((team) => team.id)
    .sort();

  const hasCompressionChanges =
    compressionMode !== serverCompressionMode ||
    (compressionMode === "team" &&
      JSON.stringify([...selectedTeamIds].sort()) !==
        JSON.stringify(serverTeamIds));

  const hasCleanupChanges = cleanupInterval !== serverCleanupInterval;

  const isInitialLoading = isOrganizationPending || areTeamsPending;
  const hasChanges =
    !isInitialLoading && (hasCompressionChanges || hasCleanupChanges);

  const handleSave = async () => {
    const mutations: Promise<unknown>[] = [];

    // Collect compression settings mutation
    if (hasCompressionChanges) {
      if (compressionMode === "disabled") {
        mutations.push(
          updateLlmSettingsMutation.mutateAsync({
            compressionScope: "organization",
            convertToolResultsToToon: false,
          }),
        );
      } else if (compressionMode === "organization") {
        mutations.push(
          updateLlmSettingsMutation.mutateAsync({
            compressionScope: "organization",
            convertToolResultsToToon: true,
          }),
        );
      } else {
        mutations.push(
          updateLlmSettingsMutation
            .mutateAsync({
              compressionScope: "team",
              convertToolResultsToToon: false,
            })
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
            .then(() => queryClient.invalidateQueries({ queryKey: ["teams"] })),
        );
      }
    }

    // Collect cleanup interval mutation
    if (hasCleanupChanges) {
      mutations.push(
        updateLlmSettingsMutation.mutateAsync({
          limitCleanupInterval: cleanupInterval,
        }),
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
    setCleanupInterval(serverCleanupInterval);
    setSelectedTeamIds(
      loadedTeams
        .filter((team) => team.convertToolResultsToToon)
        .map((team) => team.id),
    );
  };

  return (
    <div className="space-y-6">
      <SettingsBlock
        title="Apply compression to tool results"
        description="Reduce LLM token usage up to 60% by using TOON (Token-Oriented Object Notation) compression for tool results."
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
        title="Limit auto-cleanup interval"
        description="How often expired or exceeded usage limits are automatically reset."
        control={
          <WithPermissions
            permissions={{ llmSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={cleanupInterval}
                onValueChange={(value: LimitCleanupInterval) =>
                  setCleanupInterval(value)
                }
                disabled={updateLlmSettingsMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CLEANUP_INTERVAL_LABELS).map(
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
      />
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateLlmSettingsMutation.isPending}
        permissions={{ llmSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </div>
  );
}
