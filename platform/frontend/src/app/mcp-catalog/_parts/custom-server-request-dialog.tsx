"use client";

import type { archestraApiTypes } from "@shared";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateMcpServerInstallationRequest } from "@/lib/mcp-server-installation-request.query";

type ServerType =
  archestraApiTypes.CreateInternalMcpCatalogItemData["body"]["serverType"];

export function CustomServerRequestDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [formData, setFormData] = useState<{
    serverType: ServerType;
    label: string;
    name: string;
    version: string;
    serverUrl: string;
    docsUrl: string;
    command: string;
    arguments: string;
    environment: Array<{
      id: string;
      key: string;
      type: "plain_text" | "secret";
      value?: string;
      promptOnInstallation: boolean;
    }>;
    requestReason: string;
  }>({
    serverType: "remote",
    label: "",
    name: "",
    version: "",
    serverUrl: "",
    docsUrl: "",
    command: "",
    arguments: "",
    environment: [],
    requestReason: "",
  });

  const createRequest = useCreateMcpServerInstallationRequest();

  const handleAddEnvironmentVariable = () => {
    setFormData({
      ...formData,
      environment: [
        ...formData.environment,
        {
          id: `env-${Date.now()}`,
          key: "",
          type: "plain_text",
          value: "",
          promptOnInstallation: false,
        },
      ],
    });
  };

  const handleRemoveEnvironmentVariable = (index: number) => {
    setFormData({
      ...formData,
      environment: formData.environment.filter((_, i) => i !== index),
    });
  };

  const handleEnvironmentVariableChange = (
    index: number,
    field: "key" | "type" | "value",
    value: string,
  ) => {
    const newEnvironment = [...formData.environment];
    if (field === "type") {
      newEnvironment[index] = {
        ...newEnvironment[index],
        type: value as "plain_text" | "secret",
      };
    } else {
      newEnvironment[index] = { ...newEnvironment[index], [field]: value };
    }
    setFormData({ ...formData, environment: newEnvironment });
  };

  const handleSubmit = async () => {
    if (!formData.label || !formData.name) return;

    const customServerConfig: NonNullable<
      archestraApiTypes.CreateMcpServerInstallationRequestData["body"]["customServerConfig"]
    > =
      formData.serverType === "remote"
        ? {
            type: "remote" as const,
            label: formData.label,
            name: formData.name,
            version: formData.version || undefined,
            serverType: "remote" as const,
            serverUrl: formData.serverUrl || undefined,
            docsUrl: formData.docsUrl || undefined,
            userConfig: undefined,
            oauthConfig: undefined,
          }
        : {
            type: "local" as const,
            label: formData.label,
            name: formData.name,
            version: formData.version || undefined,
            serverType: "local" as const,
            localConfig: {
              command: formData.command,
              arguments: formData.arguments
                .split("\n")
                .map((arg) => arg.trim())
                .filter((arg) => arg.length > 0),
              environment:
                formData.environment.length > 0
                  ? formData.environment.map(({ id, ...env }) => env)
                  : undefined,
            },
          };

    await createRequest.mutateAsync({
      externalCatalogId: null,
      requestReason: formData.requestReason,
      customServerConfig,
    });

    // Reset form
    setFormData({
      serverType: "remote",
      label: "",
      name: "",
      version: "",
      serverUrl: "",
      docsUrl: "",
      command: "",
      arguments: "",
      environment: [],
      requestReason: "",
    });
    onClose();
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Request Custom MCP Server Installation</DialogTitle>
          <DialogDescription>
            Request a custom MCP server to be added to your organization's
            internal registry. An admin will review your request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="serverType">Server Type *</Label>
            <Select
              value={formData.serverType}
              onValueChange={(value: ServerType) =>
                handleInputChange("serverType", value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select server type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="remote">Remote</SelectItem>
                <SelectItem value="local">Local</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="label">Display Name *</Label>
              <Input
                id="label"
                placeholder="My Custom MCP Server"
                value={formData.label}
                onChange={(e) => handleInputChange("label", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Technical Name *</Label>
              <Input
                id="name"
                placeholder="my-custom-server"
                value={formData.name}
                onChange={(e) => handleInputChange("name", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="version">Version</Label>
              <Input
                id="version"
                placeholder="1.0.0"
                value={formData.version}
                onChange={(e) => handleInputChange("version", e.target.value)}
              />
            </div>
          </div>

          {/* Conditional fields based on server type */}
          {formData.serverType === "remote" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="serverUrl">Server URL</Label>
                <Input
                  id="serverUrl"
                  placeholder="https://example.com/mcp"
                  value={formData.serverUrl}
                  onChange={(e) =>
                    handleInputChange("serverUrl", e.target.value)
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="docsUrl">Documentation URL</Label>
                <Input
                  id="docsUrl"
                  placeholder="https://example.com/docs"
                  value={formData.docsUrl}
                  onChange={(e) => handleInputChange("docsUrl", e.target.value)}
                />
              </div>
            </>
          )}

          {formData.serverType === "local" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="command">Command *</Label>
                <Input
                  id="command"
                  placeholder="node"
                  value={formData.command}
                  onChange={(e) => handleInputChange("command", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="arguments">Arguments (one per line)</Label>
                <Textarea
                  id="arguments"
                  placeholder={`/path/to/server.js\n--verbose`}
                  value={formData.arguments}
                  onChange={(e) =>
                    handleInputChange("arguments", e.target.value)
                  }
                  rows={3}
                />
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Environment Variables</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddEnvironmentVariable}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Variable
                  </Button>
                </div>
                {formData.environment.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No environment variables configured.
                  </p>
                ) : (
                  <div className="border rounded-lg">
                    {/* Header Row */}
                    <div className="grid grid-cols-[2fr_1.5fr_2fr_auto] gap-2 p-3 bg-muted/50 border-b">
                      <div className="text-xs font-medium">Key</div>
                      <div className="text-xs font-medium">Type</div>
                      <div className="text-xs font-medium">Value</div>
                      <div className="w-9" /> {/* Spacer for trash icon */}
                    </div>
                    {/* Data Rows */}
                    {formData.environment.map((envVar, index) => (
                      <div
                        key={envVar.id}
                        className="grid grid-cols-[2fr_1.5fr_2fr_auto] gap-2 p-3 items-start border-b last:border-b-0"
                      >
                        <Input
                          placeholder="API_KEY"
                          className="font-mono"
                          value={envVar.key}
                          onChange={(e) =>
                            handleEnvironmentVariableChange(
                              index,
                              "key",
                              e.target.value,
                            )
                          }
                        />
                        <Select
                          value={envVar.type}
                          onValueChange={(value) =>
                            handleEnvironmentVariableChange(
                              index,
                              "type",
                              value,
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="plain_text">
                              Plain text
                            </SelectItem>
                            <SelectItem value="secret">Secret</SelectItem>
                          </SelectContent>
                        </Select>
                        {envVar.type === "plain_text" ? (
                          <Input
                            placeholder="your-value"
                            className="font-mono"
                            value={envVar.value || ""}
                            onChange={(e) =>
                              handleEnvironmentVariableChange(
                                index,
                                "value",
                                e.target.value,
                              )
                            }
                          />
                        ) : (
                          <div className="flex items-center h-10">
                            <p className="text-xs text-muted-foreground">
                              Prompted at installation
                            </p>
                          </div>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveEnvironmentVariable(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="reason">
              Reason for Request{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="reason"
              placeholder="Explain why your team needs this custom MCP server..."
              value={formData.requestReason}
              onChange={(e) =>
                handleInputChange("requestReason", e.target.value)
              }
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              createRequest.isPending ||
              !formData.label ||
              !formData.name ||
              (formData.serverType === "local" && !formData.command)
            }
          >
            {createRequest.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
