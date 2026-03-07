"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import { MultiSelect } from "@/components/ui/multi-select";
import { PermissionButton } from "@/components/ui/permission-button";
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
  const { data: organization } = useOrganization();
  const { data: teams = [] } = useTeams();
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

  // Sync state when organization data loads
  useEffect(() => {
    if (organization) {
      if (organization.compressionScope === "organization") {
        setCompressionMode(
          organization.convertToolResultsToToon ? "organization" : "disabled",
        );
      } else {
        setCompressionMode("team");
      }
      setCleanupInterval(
        (organization.limitCleanupInterval as LimitCleanupInterval) || "1h",
      );
    }
  }, [organization]);

  // Load teams with compression enabled
  useEffect(() => {
    if (teams.length > 0) {
      const enabledTeams = teams
        .filter((team) => team.convertToolResultsToToon)
        .map((team) => team.id);
      setSelectedTeamIds(enabledTeams);
    }
  }, [teams]);

  // Determine if anything has changed from server state
  const serverCompressionMode: CompressionMode =
    organization?.compressionScope === "organization"
      ? organization?.convertToolResultsToToon
        ? "organization"
        : "disabled"
      : "team";

  const serverCleanupInterval =
    (organization?.limitCleanupInterval as LimitCleanupInterval) || "1h";

  const serverTeamIds = teams
    .filter((team) => team.convertToolResultsToToon)
    .map((team) => team.id)
    .sort();

  const hasCompressionChanges =
    compressionMode !== serverCompressionMode ||
    (compressionMode === "team" &&
      JSON.stringify([...selectedTeamIds].sort()) !==
        JSON.stringify(serverTeamIds));

  const hasCleanupChanges = cleanupInterval !== serverCleanupInterval;
  const hasChanges = hasCompressionChanges || hasCleanupChanges;

  const handleSave = async () => {
    // Save compression settings
    if (hasCompressionChanges) {
      if (compressionMode === "disabled") {
        await updateLlmSettingsMutation.mutateAsync({
          compressionScope: "organization",
          convertToolResultsToToon: false,
        });
      } else if (compressionMode === "organization") {
        await updateLlmSettingsMutation.mutateAsync({
          compressionScope: "organization",
          convertToolResultsToToon: true,
        });
      } else {
        await updateLlmSettingsMutation.mutateAsync({
          compressionScope: "team",
          convertToolResultsToToon: false,
        });

        try {
          await Promise.all(
            teams.map((team) =>
              archestraApiSdk.updateTeam({
                path: { id: team.id },
                body: {
                  name: team.name,
                  description: team.description ?? undefined,
                  convertToolResultsToToon: selectedTeamIds.includes(team.id),
                },
              }),
            ),
          );
          queryClient.invalidateQueries({ queryKey: ["teams"] });
        } catch {
          toast.error("Failed to update team compression settings");
          return;
        }
      }
    }

    // Save cleanup interval
    if (hasCleanupChanges) {
      await updateLlmSettingsMutation.mutateAsync({
        limitCleanupInterval: cleanupInterval,
      });
    }
  };

  const handleCancel = () => {
    setCompressionMode(serverCompressionMode);
    setCleanupInterval(serverCleanupInterval);
    setSelectedTeamIds(
      teams
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
            {teams.length === 0 ? (
              <p className="text-sm text-muted-foreground w-48">
                No teams available
              </p>
            ) : (
              <div className="w-48">
                <MultiSelect
                  value={selectedTeamIds}
                  onValueChange={setSelectedTeamIds}
                  placeholder="Select teams..."
                  items={teams.map((team) => ({
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
      {hasChanges && (
        <div className="flex gap-3 sticky bottom-0 bg-background p-4 rounded-lg border border-border shadow-lg">
          <PermissionButton
            permissions={{ llmSettings: ["update"] }}
            onClick={handleSave}
            disabled={updateLlmSettingsMutation.isPending}
          >
            {updateLlmSettingsMutation.isPending ? "Saving..." : "Save"}
          </PermissionButton>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={updateLlmSettingsMutation.isPending}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
