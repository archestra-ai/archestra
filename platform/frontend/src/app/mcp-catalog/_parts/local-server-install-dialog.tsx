"use client";

import type { archestraApiTypes } from "@shared";
import { useState } from "react";
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

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

interface LocalServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (environmentValues: Record<string, string>) => Promise<void>;
  catalogItem: CatalogItem | null;
  isInstalling: boolean;
}

export function LocalServerInstallDialog({
  isOpen,
  onClose,
  onConfirm,
  catalogItem,
  isInstalling,
}: LocalServerInstallDialogProps) {
  // Extract environment variables that need prompting during installation
  const promptedEnvVars =
    catalogItem?.localConfig?.environment?.filter(
      (env) => env.promptOnInstallation === true,
    ) || [];

  const [environmentValues, setEnvironmentValues] = useState<
    Record<string, string>
  >(
    promptedEnvVars.reduce<Record<string, string>>((acc, env) => {
      acc[env.key] = env.value || "";
      return acc;
    }, {}),
  );

  const handleEnvVarChange = (key: string, value: string) => {
    setEnvironmentValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleInstall = async () => {
    if (!catalogItem) return;

    // Validate required fields only
    const missingEnvVars = promptedEnvVars.filter((env) => {
      // Skip validation for optional fields
      if (!env.required) return false;

      const value = environmentValues[env.key];
      // Boolean fields are always valid if they have a value (should be "true" or "false")
      if (env.type === "boolean") {
        return !value;
      }
      // For other types, check if the trimmed value is non-empty
      return !value?.trim();
    });

    if (missingEnvVars.length > 0) {
      return;
    }

    await onConfirm(environmentValues);

    // Reset form
    setEnvironmentValues({});
  };

  const handleClose = () => {
    setEnvironmentValues({});
    onClose();
  };

  // Check if there are any fields to show
  if (promptedEnvVars.length === 0) {
    // If no configuration is needed, don't show the dialog
    return null;
  }

  const isValid = promptedEnvVars.every((env) => {
    // Optional fields don't affect validation
    if (!env.required) return true;

    const value = environmentValues[env.key];
    // Boolean fields are always valid if they have a value (should be "true" or "false")
    if (env.type === "boolean") {
      return !!value;
    }
    // For other types, check if the trimmed value is non-empty
    return !!value?.trim();
  });

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Install - {catalogItem?.name}</DialogTitle>
          <DialogDescription>
            Provide the required configuration values to install this MCP
            server.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Environment Variables that need prompting */}
          {promptedEnvVars.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Environment Variables</h3>
              {promptedEnvVars.map((env) => {
                return (
                  <div key={env.key} className="space-y-2">
                    <Label htmlFor={`env-${env.key}`}>
                      {env.key}
                      {env.required && (
                        <span className="text-destructive ml-1">*</span>
                      )}
                    </Label>
                    {env.description && (
                      <p className="text-xs text-muted-foreground">
                        {env.description}
                      </p>
                    )}

                    {env.type === "boolean" ? (
                      // Boolean type: render checkbox with True/False label
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`env-${env.key}`}
                          checked={environmentValues[env.key] === "true"}
                          onCheckedChange={(checked) =>
                            handleEnvVarChange(
                              env.key,
                              checked ? "true" : "false",
                            )
                          }
                        />
                        <span className="text-sm">
                          {environmentValues[env.key] === "true"
                            ? "True"
                            : "False"}
                        </span>
                      </div>
                    ) : env.type === "number" ? (
                      // Number type: render number input
                      <Input
                        id={`env-${env.key}`}
                        type="number"
                        value={environmentValues[env.key] || ""}
                        onChange={(e) =>
                          handleEnvVarChange(env.key, e.target.value)
                        }
                        placeholder="0"
                        className="font-mono"
                      />
                    ) : (
                      // String/Secret types: render input
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
                    )}
                  </div>
                );
              })}
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
