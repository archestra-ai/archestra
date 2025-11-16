"use client";

import type { archestraApiTypes } from "@shared";
import { X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from "@/components/ui/textarea";
import { useTeams } from "@/lib/team.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface LocalServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (
    userConfigValues: Record<string, string>,
    environmentValues: Record<string, string>,
    teams?: string[],
  ) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
  authType?: "personal" | "team";
}

export function LocalServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
  authType = "personal",
}: LocalServerInstallDialogProps) {
  const [userConfigValues, setUserConfigValues] = useState<
    Record<string, string>
  >({});
  const [environmentValues, setEnvironmentValues] = useState<
    Record<string, string>
  >({});
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [currentTeamId, setCurrentTeamId] = useState<string>("");

  const { data: allTeams } = useTeams();

  // Extract user config fields
  const userConfigFields = catalogItem?.userConfig
    ? Object.entries(catalogItem.userConfig).map(([key, config]) => ({
        key,
        title: config.title,
        description: config.description,
        type: config.type,
        required: config.required,
        sensitive: config.sensitive,
      }))
    : [];

  // Extract environment variables that need prompting during installation
  const promptedEnvVars =
    catalogItem?.localConfig?.environment?.filter(
      (env) => env.promptOnInstallation === true,
    ) || [];

  const handleUserConfigChange = (key: string, value: string | boolean) => {
    setUserConfigValues((prev) => ({ ...prev, [key]: String(value) }));
  };

  const handleEnvVarChange = (key: string, value: string) => {
    setEnvironmentValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleAddTeam = (teamId: string) => {
    if (teamId && !selectedTeamIds.includes(teamId)) {
      setSelectedTeamIds([...selectedTeamIds, teamId]);
      setCurrentTeamId("");
    }
  };

  const handleRemoveSelectedTeam = (teamId: string) => {
    setSelectedTeamIds(selectedTeamIds.filter((id) => id !== teamId));
  };

  const getTeamById = (teamId: string) => {
    return allTeams?.find((team) => team.id === teamId);
  };

  const handleInstall = async () => {
    if (!catalogItem) return;

    // Validate required fields
    const missingUserConfigFields = userConfigFields.filter(
      (field) => field.required && !userConfigValues[field.key]?.trim(),
    );
    const missingEnvVars = promptedEnvVars.filter(
      (env) => !environmentValues[env.key]?.trim(),
    );

    // For team installations, require at least one team
    if (authType === "team" && selectedTeamIds.length === 0) {
      return;
    }

    if (missingUserConfigFields.length > 0 || missingEnvVars.length > 0) {
      return;
    }

    await onConfirm(
      userConfigValues,
      environmentValues,
      authType === "team" ? selectedTeamIds : undefined,
    );

    // Reset form
    setUserConfigValues({});
    setEnvironmentValues({});
    setSelectedTeamIds([]);
    setCurrentTeamId("");
  };

  const handleClose = () => {
    setUserConfigValues({});
    setEnvironmentValues({});
    setSelectedTeamIds([]);
    setCurrentTeamId("");
    onClose();
  };

  // Check if there are any fields to show
  const hasFields =
    userConfigFields.length > 0 ||
    promptedEnvVars.length > 0 ||
    authType === "team";

  if (!hasFields && authType === "personal") {
    // If no configuration is needed, don't show the dialog
    return null;
  }

  const isValid =
    userConfigFields.every(
      (field) => !field.required || userConfigValues[field.key]?.trim(),
    ) &&
    promptedEnvVars.every((env) => environmentValues[env.key]?.trim()) &&
    (authType === "personal" || selectedTeamIds.length > 0);

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {authType === "team" ? "Install for teams" : "Install for myself"} -{" "}
            {catalogItem?.name}
          </DialogTitle>
          <DialogDescription>
            {authType === "team"
              ? "Configure and install this MCP server for selected teams. Team members will be able to use this server."
              : "Provide the required configuration values to install this MCP server for your personal usage."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Team Selection for Team Auth */}
          {authType === "team" && (
            <div className="space-y-2">
              <Label htmlFor="select-team">
                Select Teams <span className="text-destructive ml-1">*</span>
              </Label>
              <Select
                value={currentTeamId}
                onValueChange={handleAddTeam}
                disabled={selectedTeamIds.length >= (allTeams?.length || 0)}
              >
                <SelectTrigger id="select-team">
                  <SelectValue placeholder="Select teams to grant access" />
                </SelectTrigger>
                <SelectContent>
                  {!allTeams || allTeams.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      No teams available
                    </div>
                  ) : (
                    allTeams
                      .filter((team) => !selectedTeamIds.includes(team.id))
                      .map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))
                  )}
                </SelectContent>
              </Select>

              {/* Selected Teams Display */}
              {selectedTeamIds.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {selectedTeamIds.map((teamId) => {
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
                          onClick={() => handleRemoveSelectedTeam(teamId)}
                          className="h-auto p-0.5 ml-1 hover:bg-destructive/20"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {/* User Config Fields */}
          {userConfigFields.length > 0 && (
            <div className="space-y-4">
              {userConfigFields.map((field) => (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={field.key}>
                    {field.title}
                    {field.required && (
                      <span className="text-destructive ml-1">*</span>
                    )}
                  </Label>
                  {field.description && (
                    <p className="text-xs text-muted-foreground">
                      {field.description}
                    </p>
                  )}
                  {field.type === "boolean" ? (
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={field.key}
                        checked={userConfigValues[field.key] === "true"}
                        onCheckedChange={(checked) =>
                          handleUserConfigChange(field.key, checked === true)
                        }
                      />
                      <Label
                        htmlFor={field.key}
                        className="text-sm font-normal cursor-pointer"
                      >
                        Enable {field.title.toLowerCase()}
                      </Label>
                    </div>
                  ) : field.type === "number" ? (
                    <Input
                      id={field.key}
                      type="number"
                      value={userConfigValues[field.key] || ""}
                      onChange={(e) =>
                        handleUserConfigChange(field.key, e.target.value)
                      }
                      placeholder={`Enter ${field.title.toLowerCase()}`}
                    />
                  ) : field.type === "directory" ? (
                    <>
                      <Input
                        id={field.key}
                        type="text"
                        value={userConfigValues[field.key] || ""}
                        onChange={(e) =>
                          handleUserConfigChange(field.key, e.target.value)
                        }
                        placeholder="/path/to/directory"
                        className="font-mono"
                      />
                      <p className="text-xs text-muted-foreground">
                        Enter the directory path on the server
                      </p>
                    </>
                  ) : field.type === "file" ? (
                    <>
                      <Input
                        id={field.key}
                        type="text"
                        value={userConfigValues[field.key] || ""}
                        onChange={(e) =>
                          handleUserConfigChange(field.key, e.target.value)
                        }
                        placeholder="/path/to/file"
                        className="font-mono"
                      />
                      <p className="text-xs text-muted-foreground">
                        Enter the file path on the server
                      </p>
                    </>
                  ) : field.sensitive ? (
                    <Input
                      id={field.key}
                      type="password"
                      value={userConfigValues[field.key] || ""}
                      onChange={(e) =>
                        handleUserConfigChange(field.key, e.target.value)
                      }
                      placeholder={`Enter ${field.title.toLowerCase()}`}
                    />
                  ) : (
                    <Textarea
                      id={field.key}
                      value={userConfigValues[field.key] || ""}
                      onChange={(e) =>
                        handleUserConfigChange(field.key, e.target.value)
                      }
                      placeholder={`Enter ${field.title.toLowerCase()}`}
                      rows={3}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Environment Variables that need prompting */}
          {promptedEnvVars.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Environment Variables</h3>
              {promptedEnvVars.map((env) => (
                <div key={env.key} className="space-y-2">
                  <Label htmlFor={`env-${env.key}`}>
                    {env.key}
                    <span className="text-destructive ml-1">*</span>
                  </Label>
                  <Input
                    id={`env-${env.key}`}
                    type={env.type === "secret" ? "password" : "text"}
                    value={environmentValues[env.key] || ""}
                    onChange={(e) =>
                      handleEnvVarChange(env.key, e.target.value)
                    }
                    placeholder={`Enter value for ${env.key}`}
                    className="font-mono"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button onClick={handleInstall} disabled={!isValid || isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
