"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DefaultUserLimitsSection } from "@/app/settings/llm/_parts/default-user-limits-section";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { LoadingSpinner } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
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
import { getFrontendDocsUrl } from "@/lib/docs/docs";
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

export default function LlmSettingsPage() {
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();
  const { data: teams, isPending: areTeamsPending } = useTeams();
  const queryClient = useQueryClient();

  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("disabled");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [hasSyncedInitialSettings, setHasSyncedInitialSettings] =
    useState(false);
  const toonDocsUrl = getFrontendDocsUrl(
    "platform-costs-and-limits",
    "toon-compression",
  );

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

  const serverTeamIds = loadedTeams
    .filter((team) => team.convertToolResultsToToon)
    .map((team) => team.id)
    .sort();

  const hasCompressionChanges =
    compressionMode !== serverCompressionMode ||
    (compressionMode === "team" &&
      JSON.stringify([...selectedTeamIds].sort()) !==
        JSON.stringify(serverTeamIds));

  const isInitialLoading =
    isOrganizationPending || areTeamsPending || !hasSyncedInitialSettings;
  const hasChanges = !isInitialLoading && hasCompressionChanges;

  const handleSave = async () => {
    if (!hasCompressionChanges) return;

    const llmSettingsBody: UpdateLlmSettingsBody = {};
    let shouldUpdateTeams = false;

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

    try {
      await updateLlmSettingsMutation.mutateAsync(llmSettingsBody);
      if (shouldUpdateTeams) {
        await Promise.all(
          loadedTeams.map((team) =>
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
        await queryClient.invalidateQueries({ queryKey: ["teams"] });
      }
    } catch {
      toast.error("Failed to save settings.");
    }
  };

  const handleCancel = () => {
    setCompressionMode(serverCompressionMode);
    setSelectedTeamIds(
      loadedTeams
        .filter((team) => team.convertToolResultsToToon)
        .map((team) => team.id),
    );
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
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateLlmSettingsMutation.isPending}
        permissions={{ llmSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
      <WithPermissions
        permissions={{ llmLimit: ["read"] }}
        noPermissionHandle="hide"
      >
        <DefaultUserLimitsSection />
      </WithPermissions>
    </SettingsSectionStack>
  );
}
