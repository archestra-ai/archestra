"use client";

import type { archestraApiTypes } from "@shared";
import { Info } from "lucide-react";
import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

interface RemoteServerInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstall: (
    catalogItem: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number],
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  catalogItem:
    | archestraApiTypes.GetInternalMcpCatalogResponses["200"][number]
    | null;
  isInstalling: boolean;
}

export function RemoteServerInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
}: RemoteServerInstallDialogProps) {
  const [configValues, setConfigValues] = useState<Record<string, string>>({});

  const handleInstall = useCallback(async () => {
    if (!catalogItem) {
      return;
    }

    // Validate required fields
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

      await onInstall(catalogItem, metadata);
      setConfigValues({});
      onClose();
    } catch (_error) {
      // Error handling is done in the parent component
    }
  }, [catalogItem, configValues, onInstall, onClose]);

  const handleClose = useCallback(() => {
    setConfigValues({});
    onClose();
  }, [onClose]);

  if (!catalogItem) {
    return null;
  }

  const userConfig =
    (catalogItem.userConfig as
      | Record<
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
        >
      | null
      | undefined) || {};
  const hasConfig = Object.keys(userConfig).length > 0;
  const hasOAuth = !!catalogItem.oauthConfig;

  // Check if all required fields are filled
  const isValid = Object.entries(userConfig)
    .filter(([_, config]) => config.required)
    .every(([fieldName, _]) => configValues[fieldName]?.trim());

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Install {catalogItem.name}</DialogTitle>
          <DialogDescription>
            {catalogItem.description ||
              "Configure this remote MCP server for installation."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
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
                {config.description && (
                  <p className="text-sm text-muted-foreground">
                    {config.description}
                  </p>
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
          <Button onClick={handleInstall} disabled={!isValid || isInstalling}>
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
