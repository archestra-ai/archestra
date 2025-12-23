"use client";

import { E2eTestId } from "@shared";
import {
  ArrowRight,
  Bot,
  Layers,
  MessageSquare,
  Network,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";

interface AlternativeOnboardingDialogProps {
  open: boolean;
}

export function AlternativeOnboardingDialog({
  open,
}: AlternativeOnboardingDialogProps) {
  const [selectedOption, setSelectedOption] = useState<"proxy" | "chat" | null>(
    null,
  );
  const [isHovering, setIsHovering] = useState<"proxy" | "chat" | null>(null);
  const { mutate: completeOnboarding } = useUpdateOrganization(
    "Onboarding complete",
    "Failed to complete onboarding",
  );

  const handleFinishOnboarding = useCallback(() => {
    completeOnboarding({
      onboardingComplete: true,
    });
  }, [completeOnboarding]);

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        handleFinishOnboarding();
      }
    },
    [handleFinishOnboarding],
  );

  const handleOptionSelect = (option: "proxy" | "chat") => {
    setSelectedOption(option);
  };

  const handleGetStarted = () => {
    if (selectedOption === "chat") {
      window.location.href = "/chat";
    } else if (selectedOption === "proxy") {
      window.location.href = "/connection";
    }
    handleFinishOnboarding();
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden border-0">
        {/* Gradient Background Header */}
        <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-8 pt-8 pb-6">
          <div className="absolute inset-0 bg-grid-white/[0.02] pointer-events-none" />
          <div className="relative">
            <DialogHeader>
              <div className="flex items-center gap-2 mb-2">
                <div className="p-2 rounded-full bg-primary/10 animate-pulse">
                  <Sparkles className="h-5 w-5 text-primary" />
                </div>
                <DialogTitle className="text-3xl font-bold bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
                  Welcome to Archestra
                </DialogTitle>
              </div>
              <DialogDescription className="text-base text-muted-foreground">
                Your unified platform for AI orchestration and tool integration
              </DialogDescription>
            </DialogHeader>
          </div>
        </div>

        <div className="px-8 py-6">
          <div className="space-y-6">
            {/* Options Grid */}
            <div className="grid gap-4 md:grid-cols-2">
              {/* Proxy Option */}
              <button
                type="button"
                onClick={() => handleOptionSelect("proxy")}
                onMouseEnter={() => setIsHovering("proxy")}
                onMouseLeave={() => setIsHovering(null)}
                className={cn(
                  "relative group rounded-2xl border-2 p-6 text-left transition-all duration-300",
                  "hover:shadow-xl hover:scale-[1.02] hover:-translate-y-1",
                  selectedOption === "proxy"
                    ? "border-primary bg-gradient-to-br from-primary/10 to-primary/5 shadow-lg"
                    : "border-muted-foreground/20 hover:border-primary/50 bg-card",
                )}
              >
                {/* Selection Indicator */}
                {selectedOption === "proxy" && (
                  <div className="absolute -top-2 -right-2 p-1 rounded-full bg-primary shadow-lg animate-in zoom-in-50">
                    <div className="h-4 w-4 rounded-full bg-primary-foreground flex items-center justify-center">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div
                      className={cn(
                        "p-3 rounded-xl transition-all duration-300",
                        selectedOption === "proxy" || isHovering === "proxy"
                          ? "bg-primary/10 scale-110"
                          : "bg-muted",
                      )}
                    >
                      <Network
                        className={cn(
                          "h-6 w-6 transition-all duration-300",
                          selectedOption === "proxy" || isHovering === "proxy"
                            ? "text-primary"
                            : "text-muted-foreground",
                        )}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Terminal className="h-4 w-4 text-muted-foreground/50" />
                      <Bot className="h-4 w-4 text-muted-foreground/50" />
                      <Layers className="h-4 w-4 text-muted-foreground/50" />
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-2 group-hover:text-primary transition-colors">
                      Secure your agent using LLM Gateway, or connect to the
                      unified MCP Gateway
                    </h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Route your existing AI agents through Archestra's secure
                      infrastructure. Perfect for teams using N8N, Cursor, or
                      custom integrations.
                    </p>
                  </div>

                  <div className="pt-3 border-t border-muted-foreground/10">
                    <div className="flex flex-wrap gap-2">
                      <span className="inline-flex items-center text-xs font-medium bg-gradient-to-r from-blue-500/10 to-blue-500/5 text-blue-600 dark:text-blue-400 px-2.5 py-1 rounded-full border border-blue-500/20">
                        N8N Compatible
                      </span>
                      <span className="inline-flex items-center text-xs font-medium bg-gradient-to-r from-purple-500/10 to-purple-500/5 text-purple-600 dark:text-purple-400 px-2.5 py-1 rounded-full border border-purple-500/20">
                        Cursor Ready
                      </span>
                      <span className="inline-flex items-center text-xs font-medium bg-gradient-to-r from-green-500/10 to-green-500/5 text-green-600 dark:text-green-400 px-2.5 py-1 rounded-full border border-green-500/20">
                        API Access
                      </span>
                    </div>
                  </div>
                </div>
              </button>

              {/* Chat Option */}
              <button
                type="button"
                onClick={() => handleOptionSelect("chat")}
                onMouseEnter={() => setIsHovering("chat")}
                onMouseLeave={() => setIsHovering(null)}
                className={cn(
                  "relative group rounded-2xl border-2 p-6 text-left transition-all duration-300",
                  "hover:shadow-xl hover:scale-[1.02] hover:-translate-y-1",
                  selectedOption === "chat"
                    ? "border-primary bg-gradient-to-br from-primary/10 to-primary/5 shadow-lg"
                    : "border-muted-foreground/20 hover:border-primary/50 bg-card",
                )}
              >
                {/* Selection Indicator */}
                {selectedOption === "chat" && (
                  <div className="absolute -top-2 -right-2 p-1 rounded-full bg-primary shadow-lg animate-in zoom-in-50">
                    <div className="h-4 w-4 rounded-full bg-primary-foreground flex items-center justify-center">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div
                      className={cn(
                        "p-3 rounded-xl transition-all duration-300",
                        selectedOption === "chat" || isHovering === "chat"
                          ? "bg-primary/10 scale-110"
                          : "bg-muted",
                      )}
                    >
                      <MessageSquare
                        className={cn(
                          "h-6 w-6 transition-all duration-300",
                          selectedOption === "chat" || isHovering === "chat"
                            ? "text-primary"
                            : "text-muted-foreground",
                        )}
                      />
                    </div>
                    <Sparkles className="h-4 w-4 text-yellow-500/50 animate-pulse" />
                  </div>

                  <div>
                    <h3 className="font-semibold text-lg mb-2 group-hover:text-primary transition-colors">
                      Use Chat Interface
                    </h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      Access MCP servers directly through our intuitive chat
                      interface. Ideal for quick interactions and tool
                      exploration.
                    </p>
                  </div>

                  <div className="pt-3 border-t border-muted-foreground/10">
                    <div className="flex flex-wrap gap-2">
                      <span className="inline-flex items-center text-xs font-medium bg-gradient-to-r from-orange-500/10 to-orange-500/5 text-orange-600 dark:text-orange-400 px-2.5 py-1 rounded-full border border-orange-500/20">
                        Built-in UI
                      </span>
                      <span className="inline-flex items-center text-xs font-medium bg-gradient-to-r from-pink-500/10 to-pink-500/5 text-pink-600 dark:text-pink-400 px-2.5 py-1 rounded-full border border-pink-500/20">
                        MCP Tools
                      </span>
                      <span className="inline-flex items-center text-xs font-medium bg-gradient-to-r from-cyan-500/10 to-cyan-500/5 text-cyan-600 dark:text-cyan-400 px-2.5 py-1 rounded-full border border-cyan-500/20">
                        No Setup
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            </div>

            {/* Next Steps Section */}
            {selectedOption && (
              <div className="animate-in slide-in-from-bottom-3 duration-500">
                <div
                  className={cn(
                    "rounded-xl p-4 border transition-all duration-300",
                    "bg-gradient-to-r",
                    selectedOption === "proxy"
                      ? "from-blue-500/5 to-purple-500/5 border-blue-500/20"
                      : "from-orange-500/5 to-pink-500/5 border-orange-500/20",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "p-2 rounded-lg",
                        selectedOption === "proxy"
                          ? "bg-blue-500/10"
                          : "bg-orange-500/10",
                      )}
                    >
                      <ArrowRight
                        className={cn(
                          "h-4 w-4",
                          selectedOption === "proxy"
                            ? "text-blue-500"
                            : "text-orange-500",
                        )}
                      />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium mb-1">
                        Ready to get started?
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {selectedOption === "proxy" ? (
                          <>
                            You'll be redirected to Settings to configure your
                            LLM Proxy endpoints and MCP Gateway connections.
                          </>
                        ) : (
                          <>
                            You'll be redirected to the Chat interface where you
                            can immediately start using MCP tools.
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-8 py-4 border-t bg-muted/30">
          <Button
            onClick={handleGetStarted}
            size="lg"
            disabled={!selectedOption}
            className={cn(
              "min-w-[160px] transition-all duration-300",
              selectedOption && "shadow-lg hover:shadow-xl",
            )}
            data-testid={E2eTestId.OnboardingFinishButton}
          >
            {selectedOption ? (
              <>
                Get Started
                <ArrowRight className="ml-2 h-4 w-4 animate-pulse" />
              </>
            ) : (
              "Select an option"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
