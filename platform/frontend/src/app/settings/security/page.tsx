"use client";

import {
  AlertTriangle,
  FileImage,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useChatApiKeys } from "@/lib/chat-settings.query";
import {
  useOrganization,
  useUpdateOrganization,
} from "@/lib/organization.query";
import { usePolicyConfigSubagentPrompt } from "@/lib/policy-config-subagent.query";

export default function SecuritySettingsPage() {
  const { data: organization } = useOrganization();
  const { data: chatApiKeys, isLoading: isLoadingApiKeys } = useChatApiKeys();
  const { data: promptTemplate } = usePolicyConfigSubagentPrompt();

  const updateOrgMutation = useUpdateOrganization(
    "Setting updated",
    "Failed to update setting",
  );

  // Check for org-wide Anthropic API key (required for auto-policy subagent)
  const hasAnthropicKey = chatApiKeys?.some(
    (key) => key.provider === "anthropic" && key.scope === "org_wide",
  );

  const handleGlobalToolPolicyChange = async (
    value: "permissive" | "restrictive",
  ) => {
    await updateOrgMutation.mutateAsync({
      globalToolPolicy: value,
    });
  };

  const handleToggleAutoConfigureNewTools = async (checked: boolean) => {
    await updateOrgMutation.mutateAsync({
      autoConfigureNewTools: checked,
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
            <CardTitle>Agentic Security</CardTitle>
          </div>
          <CardDescription>
            Configure the default security policy for tool execution and result
            treatment
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div>
            <Select
              value={organization?.globalToolPolicy ?? "permissive"}
              onValueChange={handleGlobalToolPolicyChange}
              disabled={updateOrgMutation.isPending}
            >
              <SelectTrigger id="global-tool-policy" className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="permissive">Disabled</SelectItem>
                <SelectItem value="restrictive">Enabled</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm mt-2">
              {organization?.globalToolPolicy === "restrictive" ? (
                <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400">
                  <ShieldCheck className="h-4 w-4" />
                  Policies apply to agents' tools. By default, only the first
                  tool call in session is allowed and its results are untrusted.
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
            <Switch
              id="allow-chat-file-uploads"
              checked={organization?.allowChatFileUploads ?? true}
              onCheckedChange={handleToggleAllowChatFileUploads}
              disabled={updateOrgMutation.isPending}
            />
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

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-purple-500" />
            <CardTitle>Policy Configuration Subagent</CardTitle>
          </div>
          <CardDescription>
            Analyzes trusted tool metadata with AI to generate deterministic
            security policies for handling untrusted data
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!hasAnthropicKey && !isLoadingApiKeys && (
            <div className="space-y-2 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <XCircle className="h-4 w-4" />
                <span>Requires an org-wide Anthropic API key</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Configure in{" "}
                <Link
                  href="/settings/llm-api-keys"
                  className="text-primary hover:underline"
                >
                  LLM API Keys settings
                </Link>
              </p>
            </div>
          )}
        </CardContent>
        <CardHeader>
          <CardTitle>Trigger Rules</CardTitle>
          <CardDescription>
            Configure when the subagent should run
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="auto-configure-new-tools">
                On tool assignment
              </Label>
              <p className="text-sm text-muted-foreground">
                Automatically analyze and configure security policies when tools
                are assigned
              </p>
            </div>
            <Switch
              id="auto-configure-new-tools"
              checked={organization?.autoConfigureNewTools ?? false}
              onCheckedChange={handleToggleAutoConfigureNewTools}
              disabled={!hasAnthropicKey || updateOrgMutation.isPending}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Manual trigger</Label>
              <p className="text-sm text-muted-foreground">
                Select tools on the{" "}
                <Link href="/tools" className="text-primary hover:underline">
                  Tools page
                </Link>{" "}
                and click "Configure with Subagent"
              </p>
            </div>
            <div className="text-sm text-muted-foreground">Always enabled</div>
          </div>
        </CardContent>
        <CardHeader>
          <CardTitle>Analysis Prompt</CardTitle>
          <CardDescription>
            Prompt used by the subagent to analyze tools
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted rounded-md p-4 font-mono text-xs whitespace-pre-wrap break-words overflow-x-auto">
            {promptTemplate}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
