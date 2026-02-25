"use client";

import type { archestraApiTypes } from "@shared";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { CodeText } from "@/components/code-text";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import {
  useDualLlmConfig,
  useUpdateDualLlmConfig,
} from "@/lib/dual-llm-config.query";

function DualLLMContent({
  initialData,
}: {
  initialData?: archestraApiTypes.GetDefaultDualLlmConfigResponses["200"];
}) {
  const { data: config, isPending } = useDualLlmConfig({ initialData });
  const updateConfig = useUpdateDualLlmConfig();

  const [mainProfilePrompt, setMainProfilePrompt] = useState(
    config?.mainAgentPrompt || "",
  );
  const [quarantinedProfilePrompt, setQuarantinedProfilePrompt] = useState(
    config?.quarantinedAgentPrompt || "",
  );
  const [summaryPrompt, setSummaryPrompt] = useState(
    config?.summaryPrompt || "",
  );
  const [maxRounds, setMaxRounds] = useState(config?.maxRounds || 5);

  const [particles, setParticles] = useState<
    Array<{
      id: number;
      path: "tool-to-quarantine" | "quarantine-to-main" | "main-to-output";
      progress: number;
      direction: "forward" | "backward";
    }>
  >([]);

  const particleIdRef = useRef(0);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Create particles at regular intervals
    const createParticle = () => {
      const id = particleIdRef.current++;

      // Tool to Quarantine
      setParticles((prev) => [
        ...prev,
        {
          id,
          path: "tool-to-quarantine",
          progress: 0,
          direction: "forward",
        },
      ]);

      // Quarantine to Main (Q&A back and forth)
      setTimeout(() => {
        setParticles((prev) => [
          ...prev,
          {
            id: particleIdRef.current++,
            path: "quarantine-to-main",
            progress: 0,
            direction: "forward",
          },
        ]);
      }, 600);

      // Main to Quarantine (Q&A response)
      setTimeout(() => {
        setParticles((prev) => [
          ...prev,
          {
            id: particleIdRef.current++,
            path: "quarantine-to-main",
            progress: 100,
            direction: "backward",
          },
        ]);
      }, 1200);

      // Main to Output
      setTimeout(() => {
        setParticles((prev) => [
          ...prev,
          {
            id: particleIdRef.current++,
            path: "main-to-output",
            progress: 0,
            direction: "forward",
          },
        ]);
      }, 1800);
    };

    // Start creating particles
    createParticle();
    const interval = setInterval(createParticle, 4000);

    // Smooth animation using requestAnimationFrame
    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      const deltaTime = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      setParticles((prev) => {
        return prev
          .map((particle) => {
            const speed = 50;
            const increment = speed * deltaTime;

            let newProgress = particle.progress;
            if (particle.direction === "forward") {
              newProgress = Math.min(100, particle.progress + increment);
            } else {
              newProgress = Math.max(0, particle.progress - increment);
            }

            return { ...particle, progress: newProgress };
          })
          .filter((particle) => {
            if (particle.direction === "forward") {
              return particle.progress < 100;
            } else {
              return particle.progress > 0;
            }
          });
      });

      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      clearInterval(interval);
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const getParticlePosition = useCallback((path: string, progress: number) => {
    const t = progress / 100;

    if (path === "tool-to-quarantine") {
      return {
        left: `${10 + t * 20}%`,
        top: "40%",
      };
    } else if (path === "quarantine-to-main") {
      return {
        left: `${30 + t * 20}%`,
        top: "40%",
      };
    } else {
      return {
        left: `${50 + t * 20}%`,
        top: "40%",
      };
    }
  }, []);

  const handleSave = () => {
    if (!config?.id) return;

    updateConfig.mutate({
      id: config.id,
      data: {
        enabled: true, // Always keep enabled
        mainProfilePrompt,
        quarantinedProfilePrompt,
        summaryPrompt,
        maxRounds,
      },
    });
  };

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <div>
        <div className="space-y-6">
          {/* Mobile: Collapsible "How it works" */}
          <Collapsible className="bg-card rounded-lg p-4 shadow-sm md:hidden">
            <CollapsibleTrigger className="flex w-full items-center justify-between cursor-pointer group">
              <h2 className="text-lg font-semibold">How it works</h2>
              <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="text-sm text-muted-foreground mb-6 mt-4">
                The Dual LLM quarantine pattern protects your main agent from
                prompt injection attacks by isolating untrusted data in a
                separate agent that can only respond via structured multiple
                choice answers.{" "}
                <a
                  href="https://archestra.ai/docs/platform-dual-llm"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Read the docs →
                </a>
              </p>

              <div className="relative">
                {/* Mobile: Vertical step layout with trail animation */}
                <div className="flex flex-col items-center gap-0 md:hidden py-2">
                  <style>{`
                  /* Comet trail moves through each connector */
                  @keyframes comet1 {
                    0% { top: -20px; opacity: 0; }
                    1% { opacity: 1; }
                    20% { top: 100%; opacity: 1; }
                    21% { opacity: 0; }
                    21.1%, 100% { top: -20px; opacity: 0; }
                  }
                  @keyframes comet2 {
                    0%, 28% { top: -20px; opacity: 0; }
                    29% { opacity: 1; }
                    48% { top: 100%; opacity: 1; }
                    49% { opacity: 0; }
                    49.1%, 100% { top: -20px; opacity: 0; }
                  }
                  @keyframes comet3 {
                    0%, 56% { top: -20px; opacity: 0; }
                    57% { opacity: 1; }
                    76% { top: 100%; opacity: 1; }
                    77% { opacity: 0; }
                    77.1%, 100% { top: -20px; opacity: 0; }
                  }

                  /* Brief circle flash when comet arrives */
                  @keyframes flashRed {
                    0% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
                    0.5% { box-shadow: 0 0 20px 6px rgba(239,68,68,0.6); }
                    10.5% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
                    100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
                  }
                  @keyframes flashYellow {
                    0%, 20.5% { box-shadow: 0 0 0 0 rgba(234,179,8,0); }
                    21% { box-shadow: 0 0 20px 6px rgba(234,179,8,0.6); }
                    30.5% { box-shadow: 0 0 0 0 rgba(234,179,8,0); }
                    100% { box-shadow: 0 0 0 0 rgba(234,179,8,0); }
                  }
                  @keyframes flashGreen {
                    0%, 48.5% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
                    49% { box-shadow: 0 0 20px 6px rgba(34,197,94,0.6); }
                    58.5% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
                    100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
                  }
                  @keyframes flashOutput {
                    0%, 76.5% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
                    77% { box-shadow: 0 0 20px 6px rgba(34,197,94,0.6); }
                    86.5% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
                    100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
                  }
                `}</style>

                  {/* Step 1: Tool Result */}
                  <div className="flex flex-col items-center">
                    <div
                      className="w-14 h-14 rounded-full bg-red-50 dark:bg-red-950/30 flex items-center justify-center border-2 border-red-300 dark:border-red-800"
                      style={{ animation: "flashRed 10s ease-in-out infinite" }}
                    >
                      <span className="text-xl">🔴</span>
                    </div>
                    <span className="mt-1.5 font-medium text-sm">
                      Tool Result
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Unsafe Data
                    </span>
                  </div>

                  {/* Connector 1: Red comet */}
                  <div className="relative w-1 h-14 bg-muted-foreground/10 my-1.5 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 right-0 h-5 rounded-full"
                      style={{
                        background:
                          "linear-gradient(to bottom, transparent, rgba(239,68,68,0.15), rgba(239,68,68,0.5), rgba(239,68,68,1))",
                        boxShadow: "0 2px 10px 1px rgba(239,68,68,0.7)",
                        animation: "comet1 10s ease-in-out infinite",
                      }}
                    />
                  </div>

                  {/* Step 2: Quarantined LLM */}
                  <div className="flex flex-col items-center">
                    <div
                      className="w-14 h-14 rounded-full bg-yellow-50 dark:bg-yellow-950/30 flex items-center justify-center border-2 border-yellow-300 dark:border-yellow-800"
                      style={{
                        animation: "flashYellow 10s ease-in-out infinite",
                      }}
                    >
                      <span className="text-xl">🔒</span>
                    </div>
                    <span className="mt-1.5 font-medium text-sm">
                      Quarantined LLM
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Restricted
                    </span>
                  </div>

                  {/* N rounds Q&A label */}
                  <span className="text-xs text-muted-foreground bg-card px-2 py-0.5 rounded border border-border my-1.5">
                    N rounds Q&A
                  </span>

                  {/* Connector 2: Yellow comet */}
                  <div className="relative w-1 h-14 bg-muted-foreground/10 my-1.5 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 right-0 h-5 rounded-full"
                      style={{
                        background:
                          "linear-gradient(to bottom, transparent, rgba(234,179,8,0.15), rgba(234,179,8,0.5), rgba(234,179,8,1))",
                        boxShadow: "0 2px 10px 1px rgba(234,179,8,0.7)",
                        animation: "comet2 10s ease-in-out infinite",
                      }}
                    />
                  </div>

                  {/* Step 3: Main LLM */}
                  <div className="flex flex-col items-center">
                    <div
                      className="w-14 h-14 rounded-full bg-green-50 dark:bg-green-950/30 flex items-center justify-center border-2 border-green-300 dark:border-green-800"
                      style={{
                        animation: "flashGreen 10s ease-in-out infinite",
                      }}
                    >
                      <span className="text-xl">✅</span>
                    </div>
                    <span className="mt-1.5 font-medium text-sm">Main LLM</span>
                    <span className="text-xs text-muted-foreground">
                      Privileged
                    </span>
                  </div>

                  {/* Connector 3: Green comet */}
                  <div className="relative w-1 h-14 bg-muted-foreground/10 my-1.5 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 right-0 h-5 rounded-full"
                      style={{
                        background:
                          "linear-gradient(to bottom, transparent, rgba(34,197,94,0.15), rgba(34,197,94,0.5), rgba(34,197,94,1))",
                        boxShadow: "0 2px 10px 1px rgba(34,197,94,0.7)",
                        animation: "comet3 10s ease-in-out infinite",
                      }}
                    />
                  </div>

                  {/* Step 4: Output */}
                  <div className="flex flex-col items-center">
                    <div
                      className="w-14 h-14 rounded-full bg-green-50 dark:bg-green-950/30 flex items-center justify-center border-2 border-green-300 dark:border-green-800"
                      style={{
                        animation: "flashOutput 10s ease-in-out infinite",
                      }}
                    >
                      <span className="text-xl">✅</span>
                    </div>
                    <span className="mt-1.5 font-medium text-sm">Output</span>
                    <span className="text-xs text-muted-foreground">
                      Safe Result
                    </span>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Desktop: Always-visible "How it works" */}
          <div className="hidden md:block bg-card rounded-lg p-8 shadow-sm">
            <h2 className="text-lg font-semibold mb-2">How it works</h2>
            <p className="text-sm text-muted-foreground mb-6">
              The Dual LLM quarantine pattern protects your main agent from
              prompt injection attacks by isolating untrusted data in a separate
              agent that can only respond via structured multiple choice
              answers.{" "}
              <a
                href="https://archestra.ai/docs/platform-dual-llm"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Read the docs →
              </a>
            </p>

            <div className="relative">
              {/* Desktop: Horizontal animated layout */}
              <div className="flex items-center justify-between gap-8">
                <div className="flex flex-col items-center z-10">
                  <div className="w-24 h-24 rounded-full bg-red-50 dark:bg-red-950/30 flex items-center justify-center border-2 border-red-300 dark:border-red-800 relative">
                    <span className="text-2xl">🔴</span>
                    {particles.length > 0 && (
                      <div className="absolute inset-0 rounded-full animate-pulse bg-red-500/5" />
                    )}
                  </div>
                  <span className="mt-3 font-medium text-sm">Tool Result</span>
                  <span className="text-xs text-muted-foreground">
                    Unsafe Data
                  </span>
                </div>

                <div className="flex-1 relative">
                  <div className="h-0.5 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 opacity-50 absolute top-[40%] w-full" />
                  {particles
                    .filter((p) => p.path === "tool-to-quarantine")
                    .map((particle) => {
                      const pos = getParticlePosition(
                        particle.path,
                        particle.progress,
                      );
                      const opacity = Math.min(
                        1,
                        Math.min(
                          particle.progress / 10,
                          (100 - particle.progress) / 10,
                        ),
                      );

                      return (
                        <div
                          key={particle.id}
                          className="absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300"
                          style={{
                            ...pos,
                            opacity,
                          }}
                        >
                          <div className="relative">
                            <div className="w-3 h-3 rounded-full bg-red-500 shadow-lg shadow-red-500/50" />
                            <div className="absolute inset-0 rounded-full bg-red-400 animate-ping" />
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className="flex flex-col items-center z-10">
                  <div className="w-24 h-24 rounded-full bg-yellow-50 dark:bg-yellow-950/30 flex items-center justify-center border-2 border-yellow-300 dark:border-yellow-800 relative">
                    <span className="text-2xl">🔒</span>
                    {particles.length > 0 && (
                      <div className="absolute inset-0 rounded-full animate-pulse bg-yellow-500/5" />
                    )}
                  </div>
                  <span className="mt-3 font-medium text-sm">
                    Quarantined LLM
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Restricted
                  </span>
                </div>

                <div className="flex-1 relative">
                  <div className="h-0.5 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 opacity-50 absolute top-[40%] w-full" />
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xs text-muted-foreground bg-card px-2 py-1 rounded border border-border z-10">
                    N rounds Q&A
                  </div>
                  {particles
                    .filter((p) => p.path === "quarantine-to-main")
                    .map((particle) => {
                      const pos = getParticlePosition(
                        particle.path,
                        particle.progress,
                      );
                      const opacity = Math.min(
                        1,
                        Math.min(
                          particle.progress / 10,
                          (100 - particle.progress) / 10,
                        ),
                      );

                      return (
                        <div
                          key={particle.id}
                          className="absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300"
                          style={{
                            ...pos,
                            opacity,
                          }}
                        >
                          <div className="relative">
                            <div
                              className={`w-3 h-3 rounded-full ${
                                particle.direction === "forward"
                                  ? "bg-yellow-500 shadow-lg shadow-yellow-500/50"
                                  : "bg-green-500 shadow-lg shadow-green-500/50"
                              }`}
                            />
                            <div
                              className={`absolute inset-0 rounded-full ${
                                particle.direction === "forward"
                                  ? "bg-yellow-400"
                                  : "bg-green-400"
                              } animate-ping`}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className="flex flex-col items-center z-10">
                  <div className="w-24 h-24 rounded-full bg-green-50 dark:bg-green-950/30 flex items-center justify-center border-2 border-green-300 dark:border-green-800 relative">
                    <span className="text-2xl">✅</span>
                    {particles.length > 0 && (
                      <div className="absolute inset-0 rounded-full animate-pulse bg-green-500/5" />
                    )}
                  </div>
                  <span className="mt-3 font-medium text-sm">Main LLM</span>
                  <span className="text-xs text-muted-foreground">
                    Privileged
                  </span>
                </div>

                <div className="flex-1 relative">
                  <div className="h-0.5 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 opacity-50 absolute top-[40%] w-full" />
                  {particles
                    .filter((p) => p.path === "main-to-output")
                    .map((particle) => {
                      const pos = getParticlePosition(
                        particle.path,
                        particle.progress,
                      );
                      const opacity = Math.min(
                        1,
                        Math.min(
                          particle.progress / 10,
                          (100 - particle.progress) / 10,
                        ),
                      );

                      return (
                        <div
                          key={particle.id}
                          className="absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300"
                          style={{
                            ...pos,
                            opacity,
                          }}
                        >
                          <div className="relative">
                            <div className="w-3 h-3 rounded-full bg-green-500 shadow-lg shadow-green-500/50" />
                            <div className="absolute inset-0 rounded-full bg-green-400 animate-ping" />
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className="flex flex-col items-center z-10">
                  <div className="w-24 h-24 rounded-full bg-green-50 dark:bg-green-950/30 flex items-center justify-center border-2 border-green-300 dark:border-green-800">
                    <span className="text-2xl">✅</span>
                  </div>
                  <span className="mt-3 font-medium text-sm">Output</span>
                  <span className="text-xs text-muted-foreground">
                    Safe Result
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-6 text-sm text-muted-foreground">
              <p>
                Integer indices only. No context exchanged directly between
                agents.
              </p>
            </div>
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <Label htmlFor="max-rounds" className="text-sm font-semibold">
              Max Quarantine Rounds
            </Label>
            <p className="text-xs text-muted-foreground mt-1 mb-3">
              Maximum number of Q&A rounds between main and quarantined agents.
            </p>
            <div className="flex items-center gap-3">
              <WithPermissions
                permissions={{ dualLlmConfig: ["update"] }}
                noPermissionHandle="tooltip"
              >
                {({ hasPermission }) => (
                  <Input
                    id="max-rounds"
                    type="number"
                    disabled={!hasPermission}
                    value={maxRounds}
                    onChange={(e) =>
                      setMaxRounds(Number.parseInt(e.target.value, 10))
                    }
                    className="w-32"
                  />
                )}
              </WithPermissions>
              {maxRounds !== config?.maxRounds && (
                <PermissionButton
                  permissions={{ dualLlmConfig: ["update"] }}
                  size="sm"
                  onClick={handleSave}
                  disabled={updateConfig.isPending}
                >
                  {updateConfig.isPending ? "Saving..." : "Save"}
                </PermissionButton>
              )}
            </div>
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <div className="flex items-start justify-between mb-3">
              <div>
                <Label htmlFor="main-prompt" className="text-sm font-semibold">
                  Main Profile Prompt
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  All instructions for the main agent in a single user message.
                  This agent asks questions to understand quarantined data
                  without direct access to it. Use{" "}
                  <CodeText className="text-xs">
                    {"{"}
                    {"{"}originalUserRequest{"}}"}
                  </CodeText>{" "}
                  for user request.
                </p>
              </div>
              {mainProfilePrompt !== config?.mainAgentPrompt && (
                <PermissionButton
                  permissions={{ dualLlmConfig: ["update"] }}
                  size="sm"
                  onClick={handleSave}
                  disabled={updateConfig.isPending}
                >
                  {updateConfig.isPending ? "Saving..." : "Save"}
                </PermissionButton>
              )}
            </div>
            <WithPermissions
              permissions={{ dualLlmConfig: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Textarea
                  id="main-prompt"
                  rows={20}
                  value={mainProfilePrompt}
                  onChange={(e) => setMainProfilePrompt(e.target.value)}
                  className="font-mono text-xs"
                  disabled={!hasPermission}
                />
              )}
            </WithPermissions>
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <div className="flex items-start justify-between mb-3">
              <div>
                <Label
                  htmlFor="quarantine-prompt"
                  className="text-sm font-semibold"
                >
                  Quarantined Agent Prompt
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  This agent has access to potentially malicious data but can
                  only answer multiple choice questions. Variables:{" "}
                  <CodeText className="text-xs">
                    {"{"}
                    {"{"}toolResultData{"}}"}
                  </CodeText>
                  ,{" "}
                  <CodeText className="text-xs">
                    {"{"}
                    {"{"}question{"}}"}
                  </CodeText>
                  ,{" "}
                  <CodeText className="text-xs">
                    {"{"}
                    {"{"}options{"}}"}
                  </CodeText>
                  ,{" "}
                  <CodeText className="text-xs">
                    {"{"}
                    {"{"}maxIndex{"}}"}
                  </CodeText>
                </p>
              </div>
              {quarantinedProfilePrompt !== config?.quarantinedAgentPrompt && (
                <PermissionButton
                  permissions={{ dualLlmConfig: ["update"] }}
                  size="sm"
                  onClick={handleSave}
                  disabled={updateConfig.isPending}
                >
                  {updateConfig.isPending ? "Saving..." : "Save"}
                </PermissionButton>
              )}
            </div>
            <WithPermissions
              permissions={{ dualLlmConfig: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Textarea
                  id="quarantine-prompt"
                  rows={10}
                  value={quarantinedProfilePrompt}
                  onChange={(e) => setQuarantinedProfilePrompt(e.target.value)}
                  className="font-mono text-xs"
                  disabled={!hasPermission}
                />
              )}
            </WithPermissions>
          </div>

          <div className="border border-border rounded-lg p-6 bg-card">
            <div className="flex items-start justify-between mb-3">
              <div>
                <Label
                  htmlFor="summary-prompt"
                  className="text-sm font-semibold"
                >
                  Summary Generation Prompt
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Prompt for generating safe summary from Q&A. Use{" "}
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">
                    {"{"}
                    {"{"}qaText{"}}"}
                  </code>{" "}
                  for conversation.
                </p>
              </div>
              {summaryPrompt !== config?.summaryPrompt && (
                <PermissionButton
                  permissions={{ dualLlmConfig: ["update"] }}
                  size="sm"
                  onClick={handleSave}
                  disabled={updateConfig.isPending}
                >
                  {updateConfig.isPending ? "Saving..." : "Save"}
                </PermissionButton>
              )}
            </div>
            <WithPermissions
              permissions={{ dualLlmConfig: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Textarea
                  id="summary-prompt"
                  rows={4}
                  value={summaryPrompt}
                  onChange={(e) => setSummaryPrompt(e.target.value)}
                  className="font-mono text-xs"
                  disabled={!hasPermission}
                />
              )}
            </WithPermissions>
          </div>
        </div>
      </div>
    </LoadingWrapper>
  );
}

export default function DualLLMSettingsPage() {
  return (
    <ErrorBoundary>
      <DualLLMContent />
    </ErrorBoundary>
  );
}
