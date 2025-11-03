"use client";

import { FRAMEWORK_DOCS, FRAMEWORK_LABELS, type Framework } from "@shared";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useHasFirstUserInteraction } from "@/lib/interaction.query";
import { DynamicInteraction } from "@/lib/interaction.utils";
import { useDetectedTools } from "@/lib/tool.query";
import OnboardingStep from "../onboarding-step";
import OptionButton from "../option-button";
import { AgentCreation } from "./agent-creation";
import { McpGatewayEndpoint } from "./mcp-gateway-endpoint";
import { McpServerInstallation } from "./mcp-server-installation";
import { McpServerSelection } from "./mcp-server-selection";
import ProviderDetails from "./provider-details";
import { ToolSelection } from "./tool-selection";

export type OnboardingMode = "llm-proxy" | "mcp-gateway";

export type OnboardingWizardHandle = {
  next: () => void;
  prev: () => void;
  goto: (n: number) => void;
  step: number;
};

export default forwardRef(function OnboardingWizard(
  {
    onStepChange,
    onComplete,
  }: {
    onStepChange?: (step: number) => void;
    onComplete?: () => void;
  },
  ref: React.Ref<OnboardingWizardHandle | null>,
) {
  const [step, setStep] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [mode, setMode] = useState<OnboardingMode | null>(null);
  const [framework, setFramework] = useState<Framework>(
    Object.keys(FRAMEWORK_DOCS)[0] as Framework,
  );
  const [selectedMcpServerId, setSelectedMcpServerId] = useState<string | null>(
    null,
  );
  const [selectedMcpCatalogName, setSelectedMcpCatalogName] = useState<
    string | null
  >(null);
  const [installedMcpServerId, setInstalledMcpServerId] = useState<
    string | null
  >(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);

  const frameworks = Object.keys(FRAMEWORK_DOCS) as Array<Framework>;
  const toolsDetectedRef = useRef(false);

  // Determine max step based on selected mode
  const getMaxStep = useCallback(() => {
    if (!mode) return 1;
    if (mode === "llm-proxy") return 4;
    if (mode === "mcp-gateway") return 6;
  }, [mode]);

  const next = useCallback(() => {
    setIsTransitioning(true);
    setTimeout(() => {
      setStep((s) => Math.min(getMaxStep() ?? 1, s + 1));
      setIsTransitioning(false);
    }, 150);
  }, [getMaxStep]);

  const prev = useCallback(() => {
    setIsTransitioning(true);
    setTimeout(() => {
      setStep((s) => Math.max(0, s - 1));
      setIsTransitioning(false);
    }, 150);
  }, []);

  const goto = useCallback(
    (n: number) => {
      setIsTransitioning(true);
      setTimeout(() => {
        setStep(() => Math.max(0, Math.min(getMaxStep() ?? 1, n)));
        setIsTransitioning(false);
      }, 150);
    },
    [getMaxStep],
  );

  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);

  useImperativeHandle(
    ref,
    () => ({
      next,
      prev,
      goto,
      step,
    }),
    [step, next, prev, goto],
  );

  const { data: firstUserInteraction } = useHasFirstUserInteraction({
    refetchInterval: mode === "llm-proxy" && step === 3 ? 3_000 : null,
  });

  const hasFirstInteraction = firstUserInteraction !== null;

  const { data: detectedToolsData } = useDetectedTools({
    refetchInterval:
      mode === "llm-proxy" && step === 4 && !toolsDetectedRef.current
        ? 3_000
        : null,
  });

  useEffect(() => {
    if (detectedToolsData?.hasDetectedTools) {
      toolsDetectedRef.current = true;
    }
  }, [detectedToolsData?.hasDetectedTools]);

  useEffect(() => {
    // Auto-advance when first user interaction is detected in LLM proxy mode
    if (mode === "llm-proxy" && step === 3 && hasFirstInteraction) {
      setTimeout(() => {
        goto(4);
      }, 500);
    }
  }, [step, hasFirstInteraction, goto, mode]);

  const renderStepCard = (stepIndex: number, isActive: boolean) => {
    // Step 0: Welcome
    if (stepIndex === 0) {
      return (
        <OnboardingStep
          title="Welcome to Archestra!"
          description={
            <>
              Archestra is a powerful platform that acts as both an{" "}
              <strong>LLM Proxy</strong> and an <strong>MCP Gateway</strong>,
              ensuring your agents are secure, compliant, and never turn rogue.{" "}
              <a
                href="https://www.archestra.ai/docs/platform-lethal-trifecta"
                className="text-sm text-blue-500 hover:underline"
              >
                Read more
              </a>
            </>
          }
          isActive={isActive}
          isTransitioning={isTransitioning}
          primaryAction={{
            label: "Continue",
            onClick: next,
          }}
        />
      );
    }

    // Step 1: Mode selection
    if (stepIndex === 1) {
      return (
        <OnboardingStep
          title="How would you like to use Archestra?"
          description="Choose the setup that best fits your needs"
          isActive={isActive}
          isTransitioning={isTransitioning}
        >
          <div className="flex flex-col gap-3">
            <OptionButton
              active={mode === "llm-proxy"}
              onClick={() => {
                if (isActive) {
                  // Batch both state updates together
                  setMode("llm-proxy");
                  setIsTransitioning(true);
                  setTimeout(() => {
                    setStep((s) => s + 1);
                    setIsTransitioning(false);
                  }, 150);
                }
              }}
              className="justify-start h-auto p-4"
            >
              <div className="text-left">
                <div className="font-semibold">LLM Proxy</div>
                <div className="text-xs text-slate-400 mt-1">
                  Connect your agents to secure LLM endpoints (OpenAI,
                  Anthropic, etc.)
                </div>
              </div>
            </OptionButton>

            <OptionButton
              active={mode === "mcp-gateway"}
              onClick={() => {
                if (isActive) {
                  // Batch both state updates together
                  setMode("mcp-gateway");
                  setIsTransitioning(true);
                  setTimeout(() => {
                    setStep((s) => s + 1);
                    setIsTransitioning(false);
                  }, 150);
                }
              }}
              className="justify-start h-auto p-4"
            >
              <div className="text-left">
                <div className="font-semibold">MCP Gateway</div>
                <div className="text-xs text-slate-400 mt-1  whitespace-normal break-words">
                  Install MCP servers and expose them via a secure gateway for
                  your clients (Cursor, Claude, etc.)
                </div>
              </div>
            </OptionButton>
          </div>
        </OnboardingStep>
      );
    }

    // LLM PROXY PATH
    if (mode === "llm-proxy") {
      // Step 2: Connect agent (Framework selection)
      if (stepIndex === 2) {
        return (
          <OnboardingStep
            title="Connect your first agent"
            description="In order to get started with Archestra we need to receive the first data from your agent."
            isActive={isActive}
            isTransitioning={isTransitioning}
            primaryAction={{
              label: "Continue",
              onClick: next,
            }}
          >
            <div className="flex flex-wrap gap-3 mb-4">
              {frameworks.map((f) => (
                <OptionButton
                  key={f}
                  active={framework === f}
                  onClick={() => {
                    window.open(FRAMEWORK_DOCS[f], "_blank");
                    if (isActive) setFramework(f);
                  }}
                >
                  {FRAMEWORK_LABELS[f]}
                </OptionButton>
              ))}
            </div>

            <ProviderDetails framework={framework}></ProviderDetails>
          </OnboardingStep>
        );
      }

      // Step 3: Waiting for first chat
      if (stepIndex === 3) {
        return (
          <OnboardingStep
            title="Waiting for your first chat"
            description="We're waiting for your first conversation to analyze, proxy and protect...."
            isActive={isActive}
            isTransitioning={isTransitioning}
          >
            <div className="flex justify-center gap-2">
              <div
                className="h-2 w-2 rounded-full bg-blue-500 animate-bounce"
                style={{ animationDelay: "0s" }}
              />
              <div
                className="h-2 w-2 rounded-full bg-slate-500 animate-bounce"
                style={{ animationDelay: "0.2s" }}
              />
              <div
                className="h-2 w-2 rounded-full bg-slate-500 animate-bounce"
                style={{ animationDelay: "0.4s" }}
              />
            </div>
          </OnboardingStep>
        );
      }

      // Step 4: Analysis and completion (LLM proxy)
      if (stepIndex === 4) {
        let displayMessage = "Message detected";

        if (firstUserInteraction) {
          displayMessage = new DynamicInteraction(
            firstUserInteraction,
          ).getLastUserMessage();
        }

        const hasDetectedTools = detectedToolsData?.hasDetectedTools ?? false;
        const toolCount = detectedToolsData?.detectedCount ?? 0;
        const detectedTools = (detectedToolsData?.tools ?? []).slice(2, 7);

        return (
          <OnboardingStep
            title="Analysing your first chat"
            isActive={isActive}
            isTransitioning={isTransitioning}
            primaryAction={
              hasDetectedTools
                ? {
                    label: "Configure tools policies",
                    onClick: () => {
                      onComplete?.();
                      window.location.href = "/tools";
                    },
                  }
                : undefined
            }
          >
            <div className="rounded border border-blue-500 bg-slate-950/40 p-4 mb-4 animate-in fade-in duration-500">
              <p className="text-sm text-slate-200">{displayMessage}</p>
            </div>
            {!hasDetectedTools ? (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <div className="h-2 w-2 rounded-full bg-blue-500 animate-spin" />
                <span className="animate-pulse">
                  Identifying involved tools...
                </span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm text-green-400 mb-2 animate-in fade-in duration-500">
                  <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  <span>Tools identified: {toolCount}</span>
                </div>
                <div className="rounded border border-slate-700 bg-slate-950/40 p-3 animate-in fade-in slide-in-from-bottom-2 duration-700">
                  <ul className="space-y-1.5 text-sm text-slate-300">
                    {detectedTools.map((tool) => (
                      <li key={tool.id} className="flex items-start gap-2">
                        <span className="text-blue-400 mt-0.5">•</span>
                        <span className="flex-1">
                          {tool.name}
                          {tool.description && (
                            <span className="text-slate-500 text-xs ml-1">
                              —{" "}
                              {tool.description.length > 50
                                ? `${tool.description.slice(0, 50)}...`
                                : tool.description}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </OnboardingStep>
        );
      }
    }

    // MCP GATEWAY PATH
    if (mode === "mcp-gateway") {
      // Step 2: Create Agent
      if (stepIndex === 2) {
        return (
          <AgentCreation
            isActive={isActive}
            isTransitioning={isTransitioning}
            onComplete={(agentId: string) => {
              setCreatedAgentId(agentId);
              setTimeout(() => next(), 500);
            }}
          />
        );
      }

      // Step 3: MCP Server Selection
      if (stepIndex === 3) {
        return (
          <McpServerSelection
            isActive={isActive}
            isTransitioning={isTransitioning}
            onSelect={(id: string, name?: string) => {
              setSelectedMcpServerId(id);
              setSelectedMcpCatalogName(name || id);
            }}
            onNext={next}
          />
        );
      }

      // Step 4: MCP Server Installation
      if (stepIndex === 4 && selectedMcpServerId && createdAgentId) {
        return (
          <McpServerInstallation
            isActive={isActive}
            isTransitioning={isTransitioning}
            catalogId={selectedMcpServerId}
            catalogName={selectedMcpCatalogName || "MCP Server"}
            agentId={createdAgentId}
            onComplete={(serverId) => {
              setInstalledMcpServerId(serverId);
              next();
            }}
          />
        );
      }

      // Step 5: Tool Selection
      if (stepIndex === 5 && createdAgentId) {
        return (
          <ToolSelection
            isActive={isActive}
            isTransitioning={isTransitioning}
            mcpServerId={installedMcpServerId}
            mcpServerName={selectedMcpCatalogName || undefined}
            agentId={createdAgentId}
            onComplete={() => {
              setTimeout(() => next(), 500);
            }}
          />
        );
      }

      // Step 6: MCP Gateway Endpoint
      if (stepIndex === 6) {
        return (
          <McpGatewayEndpoint
            isActive={isActive}
            isTransitioning={isTransitioning}
            agentId={createdAgentId || ""}
            onComplete={() => {
              onComplete?.();
            }}
          />
        );
      }
    }

    return null;
  };

  return (
    <div className="mx-auto max-w-xl space-y-3 text-white">
      {step >= 2 && renderStepCard(step - 1, false)}
      {renderStepCard(step, true)}
      {step <= (getMaxStep() ?? 1) - 2 && renderStepCard(step + 1, false)}
    </div>
  );
});
