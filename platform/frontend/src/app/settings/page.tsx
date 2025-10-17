"use client";

import { DEFAULT_AGENT_NAME } from "@shared";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";

export default function SettingsPage() {
  const [particles, setParticles] = useState<
    Array<{
      id: number;
      path: "agent-to-archestra" | "archestra-to-llm";
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

      // Create forward flow
      setParticles((prev) => [
        ...prev,
        {
          id,
          path: "agent-to-archestra",
          progress: 0,
          direction: "forward",
        },
      ]);

      // Delayed particle for second path
      setTimeout(() => {
        setParticles((prev) => [
          ...prev,
          {
            id: particleIdRef.current++,
            path: "archestra-to-llm",
            progress: 0,
            direction: "forward",
          },
        ]);
      }, 800);

      // Return flow
      setTimeout(() => {
        setParticles((prev) => [
          ...prev,
          {
            id: particleIdRef.current++,
            path: "archestra-to-llm",
            progress: 100,
            direction: "backward",
          },
        ]);
      }, 1600);

      setTimeout(() => {
        setParticles((prev) => [
          ...prev,
          {
            id: particleIdRef.current++,
            path: "agent-to-archestra",
            progress: 100,
            direction: "backward",
          },
        ]);
      }, 2400);
    };

    // Start creating particles
    createParticle();
    const interval = setInterval(createParticle, 4000);

    // Smooth animation using requestAnimationFrame
    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      const deltaTime = (currentTime - lastTime) / 1000; // Convert to seconds
      lastTime = currentTime;

      setParticles((prev) => {
        return prev
          .map((particle) => {
            const speed = 50; // units per second
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
            // Keep particles that are still in transit
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
    // Smooth progress from 0 to 100
    const t = progress / 100;

    if (path === "agent-to-archestra") {
      // Position from 20% to 50% horizontally
      return {
        left: `${20 + t * 30}%`,
        top: "40%",
      };
    } else {
      // Position from 50% to 80% horizontally
      return {
        left: `${50 + t * 30}%`,
        top: "40%",
      };
    }
  }, []);

  return (
    <div className="container mx-auto overflow-y-auto">
      <div className="w-full h-full">
        <div className="border-b border-border bg-card/30">
          <div className="max-w-7xl mx-auto px-8 py-8">
            <h1 className="text-2xl font-semibold tracking-tight mb-2">
              Settings
            </h1>
            <p className="text-sm text-muted-foreground">
              Archestra is a proxy between your agent and your LLM provider. It
              will collect information about your agent, tools, and data from
              the traffic.
              <br />
              <br />
              Below are instructions for how to connect to Archestra using a
              default agent (named <b>{DEFAULT_AGENT_NAME}</b>). If you'd like
              to configure a specific agent, you can do so in the{" "}
              <Link href="/agents" className="text-blue-500">
                Agents
              </Link>{" "}
              page.
            </p>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-8 py-8">
          <div className="bg-card rounded-lg p-8 shadow-sm">
            <div className="relative">
              <div className="flex items-center justify-between gap-8">
                <div className="flex flex-col items-center z-10">
                  <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center border-2 border-primary relative">
                    <svg
                      className="w-12 h-12 text-primary"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Agent icon"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
                      />
                    </svg>
                  </div>
                  <span className="mt-3 font-medium">Your Agent</span>
                </div>

                <div className="flex-1 relative">
                  <div className="h-0.5 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 opacity-50 absolute top-[40%] w-full" />
                  {particles
                    .filter((p) => p.path === "agent-to-archestra")
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
                          <div
                            className={`relative ${
                              particle.direction === "forward" ? "" : ""
                            }`}
                          >
                            <div
                              className={`w-3 h-3 rounded-full ${
                                particle.direction === "forward"
                                  ? "bg-blue-500 shadow-lg shadow-blue-500/50"
                                  : "bg-green-500 shadow-lg shadow-green-500/50"
                              }`}
                            />
                            <div
                              className={`absolute inset-0 rounded-full ${
                                particle.direction === "forward"
                                  ? "bg-blue-400"
                                  : "bg-green-400"
                              } animate-ping`}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className="flex flex-col items-center z-10">
                  <div className="w-24 h-24 rounded-full bg-white flex items-center justify-center relative border-2 border-gray-200">
                    <Image
                      src="/logo-light-mode.png"
                      alt="Archestra.AI"
                      width={60}
                      height={60}
                    />
                    {particles.length > 0 && (
                      <div className="absolute inset-0 rounded-full animate-pulse bg-blue-500/5" />
                    )}
                  </div>
                  <span className="mt-3 font-medium">Archestra.AI</span>
                </div>

                <div className="flex-1 relative">
                  <div className="h-0.5 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 opacity-50 absolute top-[40%] w-full" />
                  {particles
                    .filter((p) => p.path === "archestra-to-llm")
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
                          <div
                            className={`relative ${
                              particle.direction === "forward" ? "" : ""
                            }`}
                          >
                            <div
                              className={`w-3 h-3 rounded-full ${
                                particle.direction === "forward"
                                  ? "bg-blue-500 shadow-lg shadow-blue-500/50"
                                  : "bg-green-500 shadow-lg shadow-green-500/50"
                              }`}
                            />
                            <div
                              className={`absolute inset-0 rounded-full ${
                                particle.direction === "forward"
                                  ? "bg-blue-400"
                                  : "bg-green-400"
                              } animate-ping`}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>

                <div className="flex flex-col items-center z-10">
                  <div className="w-24 h-24 rounded-full bg-black flex items-center justify-center">
                    <span className="text-white font-bold text-lg">LLM</span>
                  </div>
                  <span className="mt-3 font-medium">LLM</span>
                </div>
              </div>
            </div>

            <div className="mt-12 space-y-6">
              <div className="border-t pt-6">
                <h3 className="font-medium mb-4">Proxy Endpoint</h3>
                <ProxyConnectionInstructions />
              </div>

              <div className="border-t pt-6">
                <h3 className="font-medium mb-4">Integration Guides</h3>
                <div className="grid grid-cols-2 gap-3">
                  <a
                    href="https://www.archestra.ai/docs/platform-n8n-example"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-sm">N8N</div>
                      <div className="text-xs text-muted-foreground">
                        Workflow automation
                      </div>
                    </div>
                    <svg
                      className="w-4 h-4 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Arrow icon"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://www.archestra.ai/docs/platform-vercel-ai-example"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-sm">Vercel AI SDK</div>
                      <div className="text-xs text-muted-foreground">
                        TypeScript framework
                      </div>
                    </div>
                    <svg
                      className="w-4 h-4 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Arrow icon"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://www.archestra.ai/docs/platform-langchain-example"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-sm">LangChain</div>
                      <div className="text-xs text-muted-foreground">
                        Python & JS framework
                      </div>
                    </div>
                    <svg
                      className="w-4 h-4 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Arrow icon"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://www.archestra.ai/docs/platform-openwebui-example"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-sm">OpenWebUI</div>
                      <div className="text-xs text-muted-foreground">
                        Chat interface
                      </div>
                    </div>
                    <svg
                      className="w-4 h-4 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Arrow icon"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://www.archestra.ai/docs/platform-pydantic-example"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-sm">Pydantic AI</div>
                      <div className="text-xs text-muted-foreground">
                        Python framework
                      </div>
                    </div>
                    <svg
                      className="w-4 h-4 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Arrow icon"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </a>

                  <a
                    href="https://www.archestra.ai/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-sm">
                        More integrations
                      </div>
                      <div className="text-xs text-muted-foreground">
                        View all guides
                      </div>
                    </div>
                    <svg
                      className="w-4 h-4 text-muted-foreground"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      role="img"
                      aria-label="Arrow icon"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
