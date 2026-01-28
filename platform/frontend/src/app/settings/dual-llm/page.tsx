"use client";

import type { archestraApiTypes } from "@shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { CodeText } from "@/components/code-text";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
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
          <div className="bg-card rounded-lg p-8 shadow-sm">
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
              <Input
                id="max-rounds"
                type="number"
                value={maxRounds}
                onChange={(e) =>
                  setMaxRounds(Number.parseInt(e.target.value, 10))
                }
                className="w-32"
              />
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
            <Textarea
              id="main-prompt"
              rows={20}
              value={mainProfilePrompt}
              onChange={(e) => setMainProfilePrompt(e.target.value)}
              className="font-mono text-xs"
            />
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
            <Textarea
              id="quarantine-prompt"
              rows={10}
              value={quarantinedProfilePrompt}
              onChange={(e) => setQuarantinedProfilePrompt(e.target.value)}
              className="font-mono text-xs"
            />
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
            <Textarea
              id="summary-prompt"
              rows={4}
              value={summaryPrompt}
              onChange={(e) => setSummaryPrompt(e.target.value)}
              className="font-mono text-xs"
            />
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
