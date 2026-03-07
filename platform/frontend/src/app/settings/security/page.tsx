"use client";

import type { archestraApiTypes } from "@shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
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
  useUpdateSecuritySettings,
} from "@/lib/organization.query";

type GlobalToolPolicy = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateSecuritySettingsData["body"]
  >["globalToolPolicy"]
>;

// UI-only type — the API uses a boolean, not a string enum
type FileUploadsEnabled = "enabled" | "disabled";

export default function SecuritySettingsPage() {
  const { data: organization } = useOrganization();

  const updateSecurityMutation = useUpdateSecuritySettings(
    "Security settings updated",
    "Failed to update security settings",
  );

  const [toolPolicy, setToolPolicy] =
    useState<GlobalToolPolicy>("permissive");
  const [fileUploads, setFileUploads] =
    useState<FileUploadsEnabled>("enabled");

  // Sync state when organization data loads
  useEffect(() => {
    if (organization) {
      setToolPolicy(organization.globalToolPolicy ?? "permissive");
      setFileUploads(
        (organization.allowChatFileUploads ?? true) ? "enabled" : "disabled",
      );
    }
  }, [organization]);

  const serverToolPolicy = organization?.globalToolPolicy ?? "permissive";
  const serverFileUploads =
    (organization?.allowChatFileUploads ?? true) ? "enabled" : "disabled";

  const hasChanges =
    toolPolicy !== serverToolPolicy || fileUploads !== serverFileUploads;

  const handleSave = async () => {
    await updateSecurityMutation.mutateAsync({
      globalToolPolicy: toolPolicy,
      allowChatFileUploads: fileUploads === "enabled",
    });
  };

  const handleCancel = () => {
    setToolPolicy(serverToolPolicy);
    setFileUploads(serverFileUploads);
  };

  const isRestrictive = toolPolicy === "restrictive";

  return (
    <div className="space-y-6">
      <SettingsBlock
        title="Agentic Security Engine"
        description="Configure the default security policy for tool execution and result treatment"
        control={
          <WithPermissions
            permissions={{ securitySettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={toolPolicy}
                onValueChange={(value: GlobalToolPolicy) =>
                  setToolPolicy(value)
                }
                disabled={updateSecurityMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="permissive">Disabled</SelectItem>
                  <SelectItem value="restrictive">Enabled</SelectItem>
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
        notice={
          isRestrictive ? (
            <span className="text-green-600 dark:text-green-400">
              Policies apply to agents' tools.{" "}
              <WithPermissions
                permissions={{ securitySettings: ["update"] }}
                noPermissionHandle="hide"
              >
                <Link
                  href="/mcp/tool-policies"
                  className="text-primary hover:underline"
                >
                  Configure policies
                </Link>
              </WithPermissions>
            </span>
          ) : (
            <span className="text-red-600 dark:text-red-400">
              Agents can perform any action. Tool calls are allowed and results
              are trusted.
            </span>
          )
        }
      />
      <SettingsBlock
        title="Chat File Uploads"
        description="Allow users to upload files in the Archestra chat UI"
        control={
          <WithPermissions
            permissions={{ securitySettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={fileUploads}
                onValueChange={(value: FileUploadsEnabled) =>
                  setFileUploads(value)
                }
                disabled={updateSecurityMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
        notice={
          <span className="text-red-600 dark:text-red-400">
            Security policies only apply to text content. File uploads (images,
            PDFs) bypass policy checks. File-based policies coming soon.
          </span>
        }
      />
      {hasChanges && (
        <div className="flex gap-3 sticky bottom-0 bg-background p-4 rounded-lg border border-border shadow-lg">
          <PermissionButton
            permissions={{ securitySettings: ["update"] }}
            onClick={handleSave}
            disabled={updateSecurityMutation.isPending}
          >
            {updateSecurityMutation.isPending ? "Saving..." : "Save"}
          </PermissionButton>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={updateSecurityMutation.isPending}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
