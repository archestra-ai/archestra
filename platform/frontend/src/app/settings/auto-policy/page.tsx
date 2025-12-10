"use client";

import { CheckCircle2, Loader2, Sparkles, XCircle } from "lucide-react";
import { Suspense } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useChatSettings } from "@/lib/chat-settings.query";

function AutoPolicySettingsContent() {
  const { data: chatSettings, isLoading } = useChatSettings();

  const isAvailable = !!chatSettings?.anthropicApiKeySecretId;

  const prompt = `You are a security expert analyzing MCP (Model Context Protocol) tools to determine appropriate security policies.

Tool Information:
- Name: {tool.name}
- Description: {tool.description}
- MCP Server: {mcpServerName}
- Parameters: {tool.parameters}

Your task is to determine two security settings:

1. "allowUsageWhenUntrustedDataIsPresent" - Should this tool be usable when untrusted data is in the context?
   - Set TRUE for: Read-only operations, search/query tools, informational tools, tools that don't expose or leak sensitive data
   - Set FALSE for: Tools that write/modify data, tools that could leak sensitive information, tools that execute code, tools that send data externally

2. "toolResultTreatment" - How should this tool's output be treated?
   - "trusted": Safe, verified data that can be used without restrictions (e.g., internal database queries, system information)
   - "untrusted": Data from external sources or user-controlled inputs that needs careful handling
   - "sanitize_with_dual_llm": Data that should be verified through dual LLM pattern before use (e.g., external API responses with mixed content)

General guidelines:
- Filesystem read operations: allowUsageWhenUntrustedDataIsPresent=true, toolResultTreatment="untrusted" (file content could be malicious)
- Filesystem write operations: allowUsageWhenUntrustedDataIsPresent=false, toolResultTreatment="trusted" (operation itself is sensitive)
- Database queries: allowUsageWhenUntrustedDataIsPresent=true, toolResultTreatment="trusted" (internal trusted data)
- External API calls: allowUsageWhenUntrustedDataIsPresent=false, toolResultTreatment="untrusted" (external data not verified)
- Code execution: allowUsageWhenUntrustedDataIsPresent=false, toolResultTreatment="untrusted"
- Search/informational: allowUsageWhenUntrustedDataIsPresent=true, toolResultTreatment="untrusted"

Analyze the tool and provide your security assessment.`;

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
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Feature Status</h3>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Checking availability...</span>
              </div>
            ) : isAvailable ? (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                <span>Auto-policy feature is enabled</span>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-amber-600">
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
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">How It Works</h3>
            <p className="text-sm text-muted-foreground">
              The auto-configure feature uses AI to analyze each tool and
              automatically determine appropriate security policies based on the
              tool's purpose, parameters, and potential risks.
            </p>
            <p className="text-sm text-muted-foreground">
              When you select tools and click "Auto-Configure" in the Tools
              page, the system analyzes each tool and sets:
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
              Auto-configured tools are marked with a{" "}
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
