"use client";

import type { archestraApiTypes } from "@shared";
import { Building2, Info, ShieldCheck, User, X } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTeams } from "@/lib/team.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

type UserConfigType = Record<
  string,
  {
    type: "string" | "number" | "boolean" | "directory" | "file";
    title: string;
    description: string;
    required?: boolean;
    default?: string | number | boolean | Array<string>;
    multiple?: boolean;
    sensitive?: boolean;
    min?: number;
    max?: number;
  }
>;

interface RemoteServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (
    catalogItem: CatalogItem,
    metadata: Record<string, unknown>,
    teams: string[],
  ) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
  isTeamMode?: boolean;
}

export function RemoteServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
  isTeamMode = false,
}: RemoteServerInstallDialogProps) {
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [assignedTeamIds, setAssignedTeamIds] = useState<string[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  const { data: teams } = useTeams();

  const handleAddTeam = (teamId: string) => {
    if (teamId && !assignedTeamIds.includes(teamId)) {
      setAssignedTeamIds([...assignedTeamIds, teamId]);
      setSelectedTeamId("");
    }
  };

  const handleRemoveTeam = (teamId: string) => {
    setAssignedTeamIds(assignedTeamIds.filter((id) => id !== teamId));
  };

  const unassignedTeams = !teams
    ? []
    : teams.filter((team) => !assignedTeamIds.includes(team.id));

  const getTeamById = (teamId: string) => {
    return teams?.find((team) => team.id === teamId);
  };

  const handleConfirm = async () => {
    if (!catalogItem) {
      return;
    }

    // Validate required fields
    const userConfig =
      (catalogItem.userConfig as UserConfigType | null | undefined) || {};
    const requiredFields = Object.entries(userConfig).filter(
      ([_, config]) => config.required,
    );

    for (const [fieldName, _] of requiredFields) {
      if (!configValues[fieldName]?.trim()) {
        return;
      }
    }

    try {
      // Convert values to appropriate types based on config
      const metadata: Record<string, unknown> = {};
      for (const [fieldName, value] of Object.entries(configValues)) {
        const configField = userConfig[fieldName];
        if (!configField) continue;

        switch (configField.type) {
          case "number":
            metadata[fieldName] = Number(value);
            break;
          case "boolean":
            metadata[fieldName] = value === "true";
            break;
          default:
            metadata[fieldName] = value;
        }
      }

      await onConfirm(catalogItem, metadata, assignedTeamIds);
      setConfigValues({});
      setAssignedTeamIds([]);
      setSelectedTeamId("");
      onClose();
    } catch (_error) {
      // Error handling is done in the parent component
    }
  };

  const handleClose = () => {
    setConfigValues({});
    setAssignedTeamIds([]);
    setSelectedTeamId("");
    onClose();
  };

  if (!catalogItem) {
    return null;
  }

  const userConfig =
    (catalogItem.userConfig as UserConfigType | null | undefined) || {};
  const hasConfig = Object.keys(userConfig).length > 0;
  const hasOAuth = !!catalogItem.oauthConfig;

  // Check if all required fields are filled
  const isValid =
    Object.entries(userConfig)
      .filter(([_, config]) => config.required)
      .every(([fieldName, _]) => configValues[fieldName]?.trim()) &&
    (!isTeamMode || assignedTeamIds.length > 0);

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <div className="flex items-end gap-2">
              {isTeamMode ? (
                <Building2 className="h-5 w-5" />
              ) : (
                <User className="h-5 w-5" />
              )}
              <span>
                {isTeamMode ? "Team" : "Personal"} Authentication
                <span className="text-muted-foreground ml-2 font-normal">
                  {catalogItem.name}
                </span>
              </span>
            </div>
            {hasOAuth && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" />
                OAuth
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-6 py-4">
          {isTeamMode && (
            <>
              <Alert className="mb-2">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  Admin only: You are configuring shared credentials
                </AlertDescription>
              </Alert>

              <div className="grid gap-2">
                <Label htmlFor="assign-team">
                  Select Teams <span className="text-destructive">*</span>
                </Label>
                <p className="text-sm text-muted-foreground">
                  Choose which teams will have access to this authentication.
                </p>
                <Select value={selectedTeamId} onValueChange={handleAddTeam}>
                  <SelectTrigger id="assign-team">
                    <SelectValue placeholder="Select a team to assign" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams?.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        No teams available
                      </div>
                    ) : unassignedTeams.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        All teams are already assigned
                      </div>
                    ) : (
                      unassignedTeams.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {assignedTeamIds.length > 0 ? (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {assignedTeamIds.map((teamId) => {
                      const team = getTeamById(teamId);
                      return (
                        <Badge
                          key={teamId}
                          variant="secondary"
                          className="flex items-center gap-1 pr-1"
                        >
                          <span>{team?.name || teamId}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveTeam(teamId)}
                            className="h-auto p-0.5 ml-1 hover:bg-destructive/20"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </Badge>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </>
          )}

          {hasOAuth && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                This server requires OAuth authentication. You'll be redirected
                to complete the authentication flow after clicking Install.
              </AlertDescription>
            </Alert>
          )}

          {hasConfig ? (
            Object.entries(userConfig).map(([fieldName, config]) => (
              <div key={fieldName} className="grid gap-2">
                <Label htmlFor={fieldName}>
                  {config.title}
                  {config.required && <span className="text-red-500"> *</span>}
                </Label>
                {config.type === "boolean" ? (
                  <select
                    id={fieldName}
                    value={configValues[fieldName] || "false"}
                    onChange={(e) =>
                      setConfigValues((prev) => ({
                        ...prev,
                        [fieldName]: e.target.value,
                      }))
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                ) : (
                  <Input
                    id={fieldName}
                    type={
                      config.sensitive
                        ? "password"
                        : config.type === "number"
                          ? "number"
                          : "text"
                    }
                    placeholder={
                      config.default?.toString() || config.description
                    }
                    value={configValues[fieldName] || ""}
                    onChange={(e) =>
                      setConfigValues((prev) => ({
                        ...prev,
                        [fieldName]: e.target.value,
                      }))
                    }
                    min={config.min}
                    max={config.max}
                  />
                )}
              </div>
            ))
          ) : !hasOAuth ? (
            <div className="rounded-md bg-muted p-4">
              <p className="text-sm text-muted-foreground">
                This remote MCP server is ready to install. No additional
                configuration is required.
              </p>
            </div>
          ) : null}

          {catalogItem.serverUrl && (
            <div className="rounded-md bg-muted p-4">
              <h4 className="text-sm font-medium mb-2">Server Details:</h4>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium">URL:</span>{" "}
                  {catalogItem.serverUrl}
                </p>
                {catalogItem.docsUrl && (
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium">Documentation:</span>{" "}
                    <a
                      href={catalogItem.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      {catalogItem.docsUrl}
                    </a>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!isValid || isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
