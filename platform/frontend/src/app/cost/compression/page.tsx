"use client";

import { archestraApiSdk } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  useUpdateOrganization,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/team.query";

export default function CompressionPage() {
  const { data: organization } = useOrganization();
  const { data: teams = [] } = useTeams();
  const queryClient = useQueryClient();

  const [compressionMode, setCompressionMode] = useState<
    "disabled" | "organization" | "team"
  >("disabled");
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  const updateOrganizationMutation = useUpdateOrganization(
    "Tool results compression settings updated",
    "Failed to update tool results compression settings",
  );

  // Sync state when organization data loads
  useEffect(() => {
    if (organization) {
      // Determine current mode based on scope and enabled state
      if (organization.compressionScope === "organization") {
        setCompressionMode(
          organization.convertToolResultsToToon ? "organization" : "disabled",
        );
      } else {
        setCompressionMode("team");
      }
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

  const checkForChanges = (
    mode: "disabled" | "organization" | "team",
    teamIds: string[],
  ) => {
    // Determine current mode from organization settings
    const currentMode =
      organization?.compressionScope === "organization"
        ? organization.convertToolResultsToToon
          ? "organization"
          : "disabled"
        : "team";

    if (mode !== currentMode) {
      return true;
    }

    // If in team mode, check if team selections changed
    if (mode === "team") {
      const currentEnabledTeams = teams
        .filter((team) => team.convertToolResultsToToon)
        .map((team) => team.id)
        .sort();
      const newEnabledTeams = [...teamIds].sort();
      return (
        JSON.stringify(currentEnabledTeams) !== JSON.stringify(newEnabledTeams)
      );
    }

    return false;
  };

  const handleSave = async () => {
    // Update organization based on selected mode
    if (compressionMode === "disabled") {
      await updateOrganizationMutation.mutateAsync({
        compressionScope: "organization",
        convertToolResultsToToon: false,
      });
    } else if (compressionMode === "organization") {
      await updateOrganizationMutation.mutateAsync({
        compressionScope: "organization",
        convertToolResultsToToon: true,
      });
    } else {
      // Team mode
      await updateOrganizationMutation.mutateAsync({
        compressionScope: "team",
        convertToolResultsToToon: false, // Not used in team mode
      });

      // Update team compression settings
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
        // Invalidate teams query to refresh data
        queryClient.invalidateQueries({ queryKey: ["teams"] });
      } catch (error) {
        toast.error("Failed to update team compression settings");
        throw error; // Re-throw to prevent setHasChanges(false) from running
      }
    }

    setHasChanges(false);
  };

  const handleCancel = () => {
    // Reset to current organization state
    if (organization) {
      if (organization.compressionScope === "organization") {
        setCompressionMode(
          organization.convertToolResultsToToon ? "organization" : "disabled",
        );
      } else {
        setCompressionMode("team");
      }
    }
    const enabledTeams = teams
      .filter((team) => team.convertToolResultsToToon)
      .map((team) => team.id);
    setSelectedTeamIds(enabledTeams);
    setHasChanges(false);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              Apply compression to tool results
            </CardTitle>
            <CardDescription>
              Reduce LLM token usage up to 60% by using TOON (Token-Oriented
              Object Notation) compression for tool results.
            </CardDescription>
            <Select
              value={compressionMode}
              onValueChange={(value: "disabled" | "organization" | "team") => {
                setCompressionMode(value);
                setHasChanges(checkForChanges(value, selectedTeamIds));
              }}
              disabled={updateOrganizationMutation.isPending}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">Disabled</SelectItem>
                <SelectItem value="organization">Organization level</SelectItem>
                <SelectItem value="team">Team level</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        {compressionMode === "team" && (
          <CardContent className="pt-6 border-t">
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
                    onValueChange={(newTeamIds) => {
                      setSelectedTeamIds(newTeamIds);
                      setHasChanges(
                        checkForChanges(compressionMode, newTeamIds),
                      );
                    }}
                    placeholder="Select teams..."
                    items={teams.map((team) => ({
                      value: team.id,
                      label: team.name,
                    }))}
                    disabled={updateOrganizationMutation.isPending}
                  />
                </div>
              )}
            </div>
          </CardContent>
        )}
      </Card>
      {hasChanges && (
        <div className="flex gap-3 sticky bottom-0 bg-background p-4 rounded-lg border border-border shadow-lg">
          <PermissionButton
            permissions={{ organization: ["update"] }}
            onClick={handleSave}
            disabled={updateOrganizationMutation.isPending}
          >
            {updateOrganizationMutation.isPending ? "Saving..." : "Save"}
          </PermissionButton>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={updateOrganizationMutation.isPending}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
