"use client";

import { Loader2, Sparkles, XCircle } from "lucide-react";
import { Suspense, useCallback } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useChatSettings,
  useUpdateChatSettings,
} from "@/lib/chat-settings.query";

function AutoPolicySettingsContent() {
  const { data: chatSettings, isLoading } = useChatSettings();
  const updateChatSettings = useUpdateChatSettings();

  const isAvailable = !!chatSettings?.anthropicApiKeySecretId;

  const handleToggleAutoConfig = useCallback(
    async (enabled: boolean) => {
      try {
        await updateChatSettings.mutateAsync({
          autoConfigureNewTools: enabled,
        });
        toast.success(
          enabled
            ? "Auto-configure enabled for new tool assignments"
            : "Auto-configure disabled for new tool assignments",
        );
      } catch (_error) {
        toast.error("Failed to update auto-configure setting");
      }
    },
    [updateChatSettings],
  );

  const prompt = `Analyze this MCP tool and determine security policies:

Tool: {tool.name}
Description: {tool.description}
MCP Server: {mcpServerName}
Parameters: {tool.parameters}

Determine:

1. allowUsageWhenUntrustedDataIsPresent (boolean)
   - TRUE: Read-only, doesn't leak sensitive data
   - FALSE: Writes data, executes code, sends data externally

2. toolResultTreatment (enum)
   - "trusted": Internal systems (databases, APIs, dev tools like list-endpoints/get-config)
   - "untrusted": External/filesystem data where exact values are safe to use directly
   - "sanitize_with_dual_llm": Untrusted data that needs summarization without exposing exact values

Examples:
- Internal dev tools: allowUsage=true, treatment="trusted"
- Database queries: allowUsage=true, treatment="trusted"
- File reads (code/config): allowUsage=true, treatment="untrusted"
- Web search/scraping: allowUsage=true, treatment="sanitize_with_dual_llm"
- File writes: allowUsage=false, treatment="trusted"
- External APIs (raw data): allowUsage=false, treatment="untrusted"
- Code execution: allowUsage=false, treatment="untrusted"`;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-purple-500" />
            <CardTitle>Auto-Configure Policies</CardTitle>
          </div>
          <CardDescription>
            Automatically configure security policies for tools using AI
            analysis
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isAvailable && !isLoading && (
            <div className="space-y-2 mb-4 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <XCircle className="h-4 w-4" />
                <span>Auto-policy feature requires configuration</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Please configure an Anthropic API key in the{" "}
                <a
                  href="/settings/chat"
                  className="text-primary hover:underline"
                >
                  Chat settings
                </a>{" "}
                to enable this feature.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-medium">
              Auto-Configure New Tool Assignments
            </h3>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="flex-1 space-y-1">
                <Label
                  htmlFor="auto-configure-toggle"
                  className="cursor-pointer"
                >
                  Automatically configure policies for newly assigned tools
                </Label>
                <p className="text-sm text-muted-foreground">
                  When enabled, security policies will be automatically
                  configured using AI analysis whenever a tool is assigned to a
                  profile.
                </p>
              </div>
              <Switch
                id="auto-configure-toggle"
                checked={chatSettings?.autoConfigureNewTools ?? false}
                disabled={!isAvailable || updateChatSettings.isPending}
                onCheckedChange={handleToggleAutoConfig}
              />
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">How It Works</h3>
            <p className="text-sm text-muted-foreground">
              <strong>Important:</strong> Before using auto-configure, you must
              manually review the MCP server and its tools to verify they are
              legitimate and trustworthy. Check that tool names, descriptions,
              and parameters contain no prompt injections or malicious content.
            </p>
            <p className="text-sm text-muted-foreground">
              Once you've verified the server is trusted, the auto-configure
              feature uses AI to generate static security policies for each
              tool. The AI analyzes the tool's metadata (name, description,
              parameters) to determine:
            </p>
            <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 ml-2">
              <li>
                <strong>In untrusted context</strong> - Whether the tool can be
                used when untrusted data is present
              </li>
              <li>
                <strong>Results are</strong> - How the tool's output should be
                treated (trusted, untrusted, or sanitized)
              </li>
            </ul>
            <p className="text-sm text-muted-foreground mt-2">
              These policies are static and won't change unless you manually
              adjust them or re-run auto-configure. Auto-configured tools are
              marked with a{" "}
              <Sparkles className="inline h-3 w-3 text-purple-500" /> icon in
              the Tools table.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Analysis Prompt</CardTitle>
          <CardDescription>
            This is the prompt used to analyze tools and determine security
            policies
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted rounded-md p-4 font-mono text-xs whitespace-pre-wrap break-words overflow-x-auto">
            {prompt}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuration Details</CardTitle>
          <CardDescription>Technical information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Model</h3>
            <p className="text-sm text-muted-foreground">
              The feature uses the model configured in Chat settings (default:
              claude-3-5-haiku-20241022)
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">API Key</h3>
            <p className="text-sm text-muted-foreground">
              The same Anthropic API key configured for Chat functionality is
              used for auto-policy analysis. This ensures consistent billing and
              access control.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Security Considerations</h3>
            <p className="text-sm text-muted-foreground">
              Auto-configured policies are recommendations based on tool
              metadata and descriptions. Always review auto-configured policies
              to ensure they align with your security requirements. You can
              manually adjust any settings after auto-configuration.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AutoPolicySettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <AutoPolicySettingsContent />
    </Suspense>
  );
}
