"use client";

import { Sparkles, XCircle } from "lucide-react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useChatApiKeys } from "@/lib/chat-settings.query";
import {
  useOrganization,
  useUpdateOrganization,
} from "@/lib/organization.query";
import { usePolicyConfigSubagentPrompt } from "@/lib/policy-config-subagent.query";

export default function AutoPolicySettingsPage() {
  const { data: chatApiKeys, isLoading } = useChatApiKeys();
  const { data: organization } = useOrganization();
  const updateOrgMutation = useUpdateOrganization(
    "Policy Configuration Subagent setting updated",
    "Failed to update subagent setting",
  );
  const { data: promptTemplate } = usePolicyConfigSubagentPrompt();

  // Check for org-wide Anthropic API key (required for auto-policy subagent)
  const hasAnthropicKey = chatApiKeys?.some(
    (key) => key.provider === "anthropic" && key.scope === "org_wide",
  );

  const handleToggleAutoConfigureNewTools = async (checked: boolean) => {
    await updateOrgMutation.mutateAsync({
      autoConfigureNewTools: checked,
    });
  };

  return (
    <div className="space-y-6">
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
          {!hasAnthropicKey && !isLoading && (
            <div className="space-y-2 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <XCircle className="h-4 w-4" />
                <span>Requires an org-wide Anthropic API key</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Configure in{" "}
                <Link
                  href="/settings/chat"
                  className="text-primary hover:underline"
                >
                  Chat settings
                </Link>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
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
      </Card>

      <Card>
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
