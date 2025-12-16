"use client";

import { Sparkles, XCircle } from "lucide-react";
import Link from "next/link";
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
import { useChatApiKeys } from "@/lib/chat-settings.query";
import { useOrganization, useUpdateOrganization } from "@/lib/organization.query";

export default function AutoPolicySettingsPage() {
  const { data: chatApiKeys, isLoading } = useChatApiKeys();
  const { data: organization } = useOrganization();
  const updateOrgMutation = useUpdateOrganization();

  // Find default Anthropic API key
  const hasAnthropicKey = chatApiKeys?.some(
    (key) => key.provider === "anthropic" && key.isOrganizationDefault,
  );

  const handleToggleAutoConfigureNewTools = async (checked: boolean) => {
    try {
      await updateOrgMutation.mutateAsync({
        autoConfigureNewTools: checked,
      });
      toast.success(
        checked
          ? "Auto-configure enabled for new tool assignments"
          : "Auto-configure disabled for new tool assignments",
      );
    } catch (error) {
      toast.error("Failed to update auto-configure setting");
    }
  };

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
          {!hasAnthropicKey && !isLoading && (
            <div className="space-y-2 mb-4 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <XCircle className="h-4 w-4" />
                <span>Auto-policy feature requires configuration</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Please configure a default Anthropic API key in the{" "}
                <Link
                  href="/settings/chat"
                  className="text-primary hover:underline"
                >
                  Chat settings
                </Link>{" "}
                to enable this feature.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-medium">How to Use</h3>
            <p className="text-sm text-muted-foreground">
              1. Set up a default Anthropic API key in{" "}
              <Link
                href="/settings/chat"
                className="text-primary hover:underline"
              >
                Chat settings
              </Link>
            </p>
            <p className="text-sm text-muted-foreground">
              2. Go to the{" "}
              <Link href="/tools" className="text-primary hover:underline">
                Tools page
              </Link>
            </p>
            <p className="text-sm text-muted-foreground">
              3. Select one or more tools
            </p>
            <p className="text-sm text-muted-foreground">
              4. Click the "Auto-Configure" button to generate security
              policies using AI
            </p>
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
          <CardTitle>Automatic Configuration</CardTitle>
          <CardDescription>
            Automatically configure policies when tools are assigned to profiles
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="auto-configure-new-tools">
                Auto-configure on tool assignment
              </Label>
              <p className="text-sm text-muted-foreground">
                When enabled, security policies will be automatically configured
                using AI analysis whenever a tool is assigned to a profile
              </p>
            </div>
            <Switch
              id="auto-configure-new-tools"
              checked={organization?.autoConfigureNewTools ?? false}
              onCheckedChange={handleToggleAutoConfigureNewTools}
              disabled={!hasAnthropicKey || updateOrgMutation.isPending}
            />
          </div>
          {!hasAnthropicKey && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              This feature requires a default Anthropic API key to be configured
              in Chat settings.
            </p>
          )}
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
            <h3 className="text-sm font-medium">API Key</h3>
            <p className="text-sm text-muted-foreground">
              The feature uses your default Anthropic chat API key configured
              in Chat settings. This ensures consistent billing and access
              control.
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

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Manual Edits</h3>
            <p className="text-sm text-muted-foreground">
              When you manually change a tool's security policies, the
              auto-configured timestamp is cleared. This helps you track which
              tools have been manually customized versus auto-configured.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
