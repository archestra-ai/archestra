"use client";

import Link from "next/link";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
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

export default function SecuritySettingsPage() {
  const { data: organization } = useOrganization();

  const updateSecurityMutation = useUpdateSecuritySettings(
    "Setting updated",
    "Failed to update setting",
  );

  const handleGlobalToolPolicyChange = async (
    value: "permissive" | "restrictive",
  ) => {
    await updateSecurityMutation.mutateAsync({
      globalToolPolicy: value,
    });
  };

  const handleToggleAllowChatFileUploads = async (checked: boolean) => {
    await updateSecurityMutation.mutateAsync({
      allowChatFileUploads: checked,
    });
  };

  const isRestrictive = organization?.globalToolPolicy === "restrictive";

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
                value={organization?.globalToolPolicy ?? "permissive"}
                onValueChange={handleGlobalToolPolicyChange}
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
                value={
                  (organization?.allowChatFileUploads ?? true)
                    ? "enabled"
                    : "disabled"
                }
                onValueChange={(value) =>
                  handleToggleAllowChatFileUploads(value === "enabled")
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
    </div>
  );
}
