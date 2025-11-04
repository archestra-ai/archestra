"use client";

import { FRAMEWORK_DOCS, FRAMEWORK_LABELS, type Framework } from "@shared";
import type { ArchestraMcpServerManifest } from "@shared/hey-api/clients/archestra-catalog/types.gen";
import { Link } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useAgents } from "@/lib/agent.query";
import { useHasFirstUserInteraction } from "@/lib/interaction.query";
import { DynamicInteraction } from "@/lib/interaction.utils";
import { useMcpServers } from "@/lib/mcp-server.query";
import { useTools } from "@/lib/tool.query";
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
  const searchParams = useSearchParams();

  // Extract query params
  const resumeOnboarding = searchParams.get("resumeOnboarding");
  const queryAgentId = searchParams.get("agentId");
  const queryMcpServerId = searchParams.get("mcpServerId");

  // Check sessionStorage as fallback for resuming onboarding
  const sessionOnboardingStep =
    typeof window !== "undefined"
      ? sessionStorage.getItem("onboarding_step")
      : null;
  const sessionAgentId =
    typeof window !== "undefined"
      ? sessionStorage.getItem("onboarding_agent_id")
      : null;
  const sessionMode =
    typeof window !== "undefined"
      ? (sessionStorage.getItem("onboarding_mode") as OnboardingMode | null)
      : null;
  const sessionMcpServerId =
    typeof window !== "undefined"
      ? sessionStorage.getItem("onboarding_mcp_server_id")
      : null;

  // Determine initial step based on query params OR sessionStorage
  // Priority: Query params (for OAuth callback) > SessionStorage (for page refresh)
  const agentIdToUse = queryAgentId || sessionAgentId;
  const mcpServerIdToUse = queryMcpServerId || sessionMcpServerId;
  const stepToUse = sessionOnboardingStep
    ? parseInt(sessionOnboardingStep, 10)
    : 0;

  // For OAuth callback, always use step 5 (tool selection)
  // For page refresh with sessionStorage, use saved step and mode
  // Otherwise, start fresh at step 0
  const initialStep =
    resumeOnboarding === "true" ? 5 : sessionOnboardingStep ? stepToUse : 0;
  const initialMode =
    resumeOnboarding === "true"
      ? ("mcp-gateway" as OnboardingMode)
      : sessionMode || null;

  const [step, setStep] = useState(initialStep);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [mode, setMode] = useState<OnboardingMode | null>(initialMode);
  const [framework, setFramework] = useState<Framework>(
    Object.keys(FRAMEWORK_DOCS)[0] as Framework,
  );
  const [selectedMcpServer, setSelectedMcpServer] =
    useState<ArchestraMcpServerManifest | null>(null);
  const [installedMcpServerId, setInstalledMcpServerId] = useState<
    string | null
  >(mcpServerIdToUse || null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(
    agentIdToUse || null,
  );

  const frameworks = Object.keys(FRAMEWORK_DOCS) as Array<Framework>;
  const toolsDetectedRef = useRef(false); // Check for existing agents and MCP servers
  const { data: existingAgents } = useAgents();
  const { data: existingMcpServers } = useMcpServers();

  const hasExistingAgent = (existingAgents?.length ?? 0) > 0;
  const hasExistingMcpServer = (existingMcpServers?.length ?? 0) > 0;

  // Auto-select first agent if one exists and we're in MCP gateway mode
  /*useEffect(() => {
    if (
      mode === "mcp-gateway" &&
      hasExistingAgent &&
      !createdAgentId &&
      existingAgents?.[0]
    ) {
      setCreatedAgentId(existingAgents[0].id);
    }
  }, [mode, hasExistingAgent, createdAgentId, existingAgents]);*/

  // Determine max step based on selected mode
  const getMaxStep = useCallback(() => {
    if (!mode) return 1;
    if (mode === "llm-proxy") return 5;
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

  // Save step, mode, agentId, and mcpServerId to sessionStorage whenever they change
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (step > 0) {
        sessionStorage.setItem("onboarding_step", step.toString());
      }
      if (mode) {
        sessionStorage.setItem("onboarding_mode", mode);
      }
      if (createdAgentId) {
        sessionStorage.setItem("onboarding_agent_id", createdAgentId);
      }
      if (installedMcpServerId) {
        sessionStorage.setItem(
          "onboarding_mcp_server_id",
          installedMcpServerId,
        );
      }
    }
  }, [step, mode, createdAgentId, installedMcpServerId]);

  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);

  // Auto-advance through skipped steps when entering MCP gateway mode
  /*useEffect(() => {
    if (
      mode === "mcp-gateway" &&
      step === 2 &&
      hasExistingAgent &&
      createdAgentId
    ) {
      // Skip agent creation step
      setTimeout(() => next(), 150);
    }
  }, [mode, step, hasExistingAgent, createdAgentId, next]);*/

  useEffect(() => {
    if (mode === "mcp-gateway" && step === 3 && hasExistingMcpServer) {
      // Skip MCP server selection step
      setTimeout(() => next(), 150);
    }
  }, [mode, step, hasExistingMcpServer, next]);

  useEffect(() => {
    if (mode === "mcp-gateway" && step === 4 && hasExistingMcpServer) {
      // Skip MCP server installation step
      setTimeout(() => next(), 150);
    }
  }, [mode, step, hasExistingMcpServer, next]);

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
    agentId: createdAgentId || undefined,
    refetchInterval:
      mode === "llm-proxy" && step === 4 && createdAgentId ? 3_000 : null,
  });

  const hasFirstInteraction = firstUserInteraction !== null;

  const { data: allTools } = useTools({
    refetchInterval:
      mode === "llm-proxy" && step === 5 && !toolsDetectedRef.current
        ? 3_000
        : null,
  });

  // Filter tools by agent ID and created in the last 5 minutes
  const recentlyDetectedTools = (allTools ?? []).filter((tool) => {
    // Filter by agent ID (note: tool has 'agent' singular, not 'agents')
    if (tool.agent?.id !== createdAgentId) {
      return false;
    }

    // Filter by creation time (last 5 minutes)
    if (!tool.createdAt) return false;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const toolCreatedAt = new Date(tool.createdAt).getTime();
    return toolCreatedAt >= fiveMinutesAgo;
  });

  const hasDetectedTools = recentlyDetectedTools.length > 0;

  useEffect(() => {
    if (hasDetectedTools) {
      toolsDetectedRef.current = true;
    }
  }, [hasDetectedTools]);

  useEffect(() => {
    // Auto-advance when first user interaction is detected in LLM proxy mode
    if (mode === "llm-proxy" && step === 4 && hasFirstInteraction) {
      setTimeout(() => {
        goto(5);
      }, 500);
    }
  }, [step, hasFirstInteraction, goto, mode]);

  const renderStepCard = (
    stepIndex: number,
    isActive: boolean,
    isNextStep: boolean,
  ) => {
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
          isNextStep={isNextStep}
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
          isNextStep={isNextStep}
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
            isNextStep={isNextStep}
          />
        );
      }

      // Step 3: Connect agent (Framework selection)
      if (stepIndex === 3) {
        return (
          <OnboardingStep
            title="Connect your first agent"
            description="In order to get started with Archestra we need to receive the first data from your agent.\nHow to set it up:"
            isActive={isActive}
            isTransitioning={isTransitioning}
            primaryAction={{
              label: "Continue",
              onClick: next,
            }}
            isNextStep={isNextStep}
          >
            <p className="text-sm text-slate-300">How to set it up :</p>
            <div className="flex flex-wrap gap-3 mb-4">
              {frameworks.map((f) => (
                <a
                  key={f}
                  href={FRAMEWORK_DOCS[f]}
                  target="_blank"
                  className="text-sm text-blue-500 hover:underline"
                  onClick={() => {
                    if (isActive) setFramework(f);
                  }}
                >
                  {FRAMEWORK_LABELS[f]}
                </a>
              ))}
            </div>

            <ProviderDetails
              framework={framework}
              agentId={createdAgentId}
            ></ProviderDetails>
          </OnboardingStep>
        );
      }

      // Step 4: Waiting for first chat
      if (stepIndex === 4) {
        return (
          <OnboardingStep
            title="Waiting for your first chat"
            description="We're waiting for your first conversation to analyze, proxy and protect...."
            isActive={isActive}
            isTransitioning={isTransitioning}
            isNextStep={isNextStep}
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

      // Step 5: Analysis and completion (LLM proxy)
      if (stepIndex === 5) {
        let displayMessage = "Message detected";

        if (firstUserInteraction) {
          displayMessage = new DynamicInteraction(
            firstUserInteraction,
          ).getLastUserMessage();
        }

        const toolCount = recentlyDetectedTools.length;
        const detectedTools = recentlyDetectedTools.slice(0, 5);

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
            isNextStep={isNextStep}
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
      // Step 2: Create Agent (skip if agent exists)
      if (stepIndex === 2) {
        if (hasExistingAgent && createdAgentId) {
          // Skip to next step if agent already exists
          //return null;
        }
        return (
          <AgentCreation
            isActive={isActive}
            isTransitioning={isTransitioning}
            onComplete={(agentId: string) => {
              setCreatedAgentId(agentId);
              setTimeout(() => next(), 500);
            }}
            isNextStep={isNextStep}
          />
        );
      }

      // Step 3: MCP Server Selection (skip if MCP server exists)
      if (stepIndex === 3) {
        if (hasExistingMcpServer && existingMcpServers?.[0]) {
          // Skip to next step if MCP server already exists
          return null;
        }
        return (
          <McpServerSelection
            isActive={isActive}
            isTransitioning={isTransitioning}
            onSelect={(mcpServer: ArchestraMcpServerManifest) => {
              setSelectedMcpServer(mcpServer);
            }}
            onNext={next}
            isNextStep={isNextStep}
          />
        );
      }

      // Step 4: MCP Server Installation (skip if MCP server exists)
      if (stepIndex === 4) {
        if (hasExistingMcpServer && existingMcpServers?.[0]) {
          // Skip to next step if MCP server already exists
          return null;
        }
        if (selectedMcpServer && createdAgentId) {
          return (
            <McpServerInstallation
              isActive={isActive}
              isTransitioning={isTransitioning}
              server={selectedMcpServer}
              agentId={createdAgentId}
              onComplete={(serverId) => {
                setInstalledMcpServerId(serverId);
                next();
              }}
              isNextStep={isNextStep}
            />
          );
        }
      }

      // Step 5: Tool Selection
      if (stepIndex === 5 && createdAgentId) {
        // Use installed MCP server ID or fall back to first existing MCP server
        const mcpServerId =
          installedMcpServerId ||
          (hasExistingMcpServer ? existingMcpServers?.[0]?.id : null);

        return (
          <ToolSelection
            isActive={isActive}
            isTransitioning={isTransitioning}
            mcpServerId={mcpServerId}
            mcpServerName={
              selectedMcpServer?.name || existingMcpServers?.[0]?.name
            }
            agentId={createdAgentId}
            onComplete={() => {
              setTimeout(() => next(), 500);
            }}
            isNextStep={isNextStep}
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
            isNextStep={isNextStep}
          />
        );
      }
    }

    return null;
  };

  return (
    <div className="mx-auto max-w-xl space-y-3 text-white">
      {step >= 2 && renderStepCard(step - 1, false, false)}
      {renderStepCard(step, true, false)}
      {step <= (getMaxStep() ?? 1) - 2 && renderStepCard(step + 1, false, true)}
    </div>
  );
});
