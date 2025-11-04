"use client";

import { McpConnectionInstructions } from "../mcp-connection-instructions";
import OnboardingStep from "../onboarding-step";

interface McpGatewayEndpointProps {
  isActive: boolean;
  isTransitioning: boolean;
  isNextStep?: boolean;
  agentId: string;
  onComplete: () => void;
}

export function McpGatewayEndpoint({
  isActive,
  isTransitioning,
  isNextStep,
  agentId,
  onComplete,
}: McpGatewayEndpointProps) {
  return (
    <OnboardingStep
      title="Your MCP Gateway is ready!"
      description="Share this endpoint with your MCP clients to start using your tools"
      isActive={isActive}
      isTransitioning={isTransitioning}
      primaryAction={{
        label: "Complete Setup",
        onClick: onComplete,
      }}
      isNextStep={isNextStep}
    >
      <div className="space-y-4">
        <div className="p-4">
          <p className="text-sm text-slate-400 mb-3">
            Add this configuration to your MCP client (Cursor, Claude Desktop,
            etc.):
          </p>
          <McpConnectionInstructions agentId={agentId} darkMode={true} />
        </div>

        <div className="bg-blue-950/30 border border-blue-700/50 rounded p-3">
          <p className="text-xs text-blue-200">
            💡 <strong>Tip:</strong> You can now use your tools through any
            MCP-compatible client. The gateway will handle security policies and
            tool access control automatically.
          </p>
        </div>
      </div>
    </OnboardingStep>
  );
}
