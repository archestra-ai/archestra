"use client";

import type { archestraApiTypes } from "@shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface LocalServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstall: (
    userConfigValues: Record<string, string>,
    environmentValues: Record<string, string>,
  ) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
}

export function LocalServerInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
}: LocalServerInstallDialogProps) {
  const [userConfigValues, setUserConfigValues] = useState<
    Record<string, string>
  >({});
  const [environmentValues, setEnvironmentValues] = useState<
    Record<string, string>
  >({});

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

  // Extract secret environment variables
  const secretEnvVars =
    catalogItem?.localConfig?.environment?.filter(
      (env) => env.type === "secret",
    ) || [];

  const handleUserConfigChange = (key: string, value: string) => {
    setUserConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleEnvVarChange = (key: string, value: string) => {
    setEnvironmentValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleInstall = async () => {
    if (!catalogItem) return;

    // Validate required fields
    const missingUserConfigFields = userConfigFields.filter(
      (field) => field.required && !userConfigValues[field.key]?.trim(),
    );
    const missingEnvVars = secretEnvVars.filter(
      (env) => !environmentValues[env.key]?.trim(),
    );

    if (missingUserConfigFields.length > 0 || missingEnvVars.length > 0) {
      // TODO: Show error message
      return;
    }

    await onInstall(userConfigValues, environmentValues);

    // Reset form
    setUserConfigValues({});
    setEnvironmentValues({});
  };

  const handleClose = () => {
    setUserConfigValues({});
    setEnvironmentValues({});
    onClose();
  };

  // Check if there are any fields to show
  const hasFields = userConfigFields.length > 0 || secretEnvVars.length > 0;

  if (!hasFields) {
    // If no configuration is needed, don't show the dialog
    return null;
  }

  const isValid =
    userConfigFields.every(
      (field) => !field.required || userConfigValues[field.key]?.trim(),
    ) && secretEnvVars.every((env) => environmentValues[env.key]?.trim());

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure {catalogItem?.name}</DialogTitle>
          <DialogDescription>
            Provide the required configuration values to install this MCP
            server.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* User Config Fields */}
          {userConfigFields.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Configuration</h3>
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
                  {field.sensitive ? (
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

          {/* Secret Environment Variables */}
          {secretEnvVars.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Environment Variables</h3>
              {secretEnvVars.map((env) => (
                <div key={env.key} className="space-y-2">
                  <Label htmlFor={`env-${env.key}`}>
                    {env.key}
                    <span className="text-destructive ml-1">*</span>
                  </Label>
                  <Input
                    id={`env-${env.key}`}
                    type="password"
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
