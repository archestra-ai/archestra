"use client";

import { AlertTriangle, FileImage, ShieldCheck, ShieldOff } from "lucide-react";
import Link from "next/link";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateOrganization,
} from "@/lib/organization.query";

export default function SecuritySettingsPage() {
  const { data: organization } = useOrganization();

  const updateOrgMutation = useUpdateOrganization(
    "Setting updated",
    "Failed to update setting",
  );

  const handleGlobalToolPolicyChange = async (
    value: "permissive" | "restrictive",
  ) => {
    await updateOrgMutation.mutateAsync({
      globalToolPolicy: value,
    });
  };

  const handleToggleAllowChatFileUploads = async (checked: boolean) => {
    await updateOrgMutation.mutateAsync({
      allowChatFileUploads: checked,
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-500" />
            <CardTitle>Agentic Security Engine</CardTitle>
          </div>
          <CardDescription>
            Configure the default security policy for tool execution and result
            treatment
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div>
            <div className="w-fit">
              <WithPermissions
                permissions={{ organization: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <Select
                    value={organization?.globalToolPolicy ?? "permissive"}
                    onValueChange={handleGlobalToolPolicyChange}
                    disabled={updateOrgMutation.isPending || !hasPermission}
                  >
                    <SelectTrigger
                      id="global-tool-policy"
                      className="w-[140px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="permissive">Disabled</SelectItem>
                      <SelectItem value="restrictive">Enabled</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </WithPermissions>
            </div>
            <p className="text-sm mt-2">
              {organization?.globalToolPolicy === "restrictive" ? (
                <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400">
                  <ShieldCheck className="h-4 w-4" />
                  Policies apply to agents' tools.
                  <WithPermissions
                    permissions={{ organization: ["update"] }}
                    noPermissionHandle="hide"
                  >
                    <Link
                      href="/tool-policies"
                      className="text-primary hover:underline"
                    >
                      Click here to configure policies
                    </Link>
                  </WithPermissions>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400">
                  <ShieldOff className="h-4 w-4" />
                  Agents can perform any action. Tool calls are allowed and
                  results are trusted.
                </span>
              )}
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileImage className="h-5 w-5 text-blue-500" />
              <CardTitle>Chat File Uploads</CardTitle>
            </div>
            <WithPermissions
              permissions={{ organization: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Switch
                  id="allow-chat-file-uploads"
                  checked={organization?.allowChatFileUploads ?? true}
                  onCheckedChange={handleToggleAllowChatFileUploads}
                  disabled={updateOrgMutation.isPending || !hasPermission}
                />
              )}
            </WithPermissions>
          </div>
          <CardDescription>
            Allow users to upload files in the Archestra chat UI
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <strong>Security notice:</strong> Tool invocation policies and
              trusted data policies currently only apply to text-based content.
              File-based content (images, PDFs) bypasses these security checks.
              Support for file-based security policies is coming soon.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
