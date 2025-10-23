"use client";

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
import { FRAMEWORK_DOCS, PROVIDER_INFO } from "../../../../shared";
import CopyButton from "../ui/copy-button";
import OnboardingStep from "../ui/onboarding-step";
import OptionButton from "../ui/option-button";

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
  const [framework, setFramework] = useState<"n8n" | "langchain" | "openwebui">(
    "n8n",
  );
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");

  const [proxyUrl, setProxyUrl] = useState("https://localhost:9000/v1/openai");

  const frameworks: Array<typeof framework> = ["n8n", "langchain", "openwebui"];

  const toolsDetectedRef = useRef(false);

  const next = useCallback(() => {
    setIsTransitioning(true);
    setTimeout(() => {
      setStep((s) => Math.min(3, s + 1));
      setIsTransitioning(false);
    }, 150);
  }, []);

  const prev = useCallback(() => {
    setIsTransitioning(true);
    setTimeout(() => {
      setStep((s) => Math.max(0, s - 1));
      setIsTransitioning(false);
    }, 150);
  }, []);

  const goto = useCallback((n: number) => {
    setIsTransitioning(true);
    setTimeout(() => {
      setStep(() => Math.max(0, Math.min(3, n)));
      setIsTransitioning(false);
    }, 150);
  }, []);

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

  useEffect(() => {
    setProxyUrl(PROVIDER_INFO[provider].baseUrl);
  }, [provider]);

  const { data: firstUserInteraction } = useHasFirstUserInteraction({
    refetchInterval: step === 2 ? 3_000 : null,
  });

  const hasFirstInteraction = firstUserInteraction !== null;

  const { data: detectedToolsData } = useDetectedTools({
    refetchInterval: step === 3 && !toolsDetectedRef.current ? 3_000 : null,
  });

  useEffect(() => {
    if (detectedToolsData?.hasDetectedTools) {
      toolsDetectedRef.current = true;
    }
  }, [detectedToolsData?.hasDetectedTools]);

  useEffect(() => {
    // Auto-advance to step 3 when first user interaction is detected
    if (step === 2 && hasFirstInteraction) {
      setTimeout(() => {
        goto(3);
      }, 500);
    }
  }, [step, hasFirstInteraction, goto]);

  const renderStepCard = (stepIndex: number, isActive: boolean) => {
    if (stepIndex === 0) {
      return (
        <OnboardingStep
          title="Welcome to Archestra!"
          description={
            <>
              Archestra is a proxy that sits between your agent and your LLM and
              makes sure that your agents never turn rogue and do unwanted,
              dangerous things.{" "}
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

    if (stepIndex === 1) {
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
                onClick={() =>
                  window.open(FRAMEWORK_DOCS[f], "_blank") &&
                  isActive &&
                  setFramework(f)
                }
              >
                {f === "n8n"
                  ? "N8N"
                  : f === "langchain"
                    ? "LangChain"
                    : f === "openwebui"
                      ? "OpenWebUI"
                      : "Custom"}
              </OptionButton>
            ))}
          </div>

          <div className="mb-4">
            <div className="block text-sm text-slate-300 mb-2">Provider</div>
            <div className="flex gap-3">
              <OptionButton
                active={provider === "openai"}
                onClick={() => isActive && setProvider("openai")}
              >
                OpenAI
              </OptionButton>
              <OptionButton
                active={provider === "anthropic"}
                onClick={() => isActive && setProvider("anthropic")}
              >
                Anthropic
              </OptionButton>
            </div>
          </div>

          <div className="mb-6">
            <label
              htmlFor="proxy-url"
              className="block text-sm text-slate-300 mb-2"
            >
              Proxy URL
            </label>
            <div className="relative">
              <input
                id="proxy-url"
                type="text"
                value={proxyUrl}
                onChange={(e) => isActive && setProxyUrl(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-950/20 px-3 py-2 pr-20 text-sm text-slate-200"
                disabled={!isActive}
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                <CopyButton
                  text={proxyUrl}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200"
                />
              </div>
            </div>
            {framework && (
              <a
                href={FRAMEWORK_DOCS[framework]}
                className="text-sm text-blue-500 hover:underline"
              >
                Learn where to set it up
              </a>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="block text-sm text-slate-300">Code Snippet</div>
              <CopyButton
                text={PROVIDER_INFO[provider].snippet}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200"
              />
            </div>
            <pre className="rounded bg-slate-950 border border-slate-700 p-4 text-xs text-slate-200 overflow-x-auto">
              <code>{PROVIDER_INFO[provider].snippet}</code>
            </pre>
          </div>
        </OnboardingStep>
      );
    }

    if (stepIndex === 2) {
      return (
        <OnboardingStep
          title="Waiting for your first chat"
          description="We're waiting for your first conversation to analyse, proxy and protect...."
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

    if (stepIndex === 3) {
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
                Identifying involved tools.....
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

    return null;
  };

  return (
    <div className="mx-auto max-w-xl space-y-3 text-white">
      {step >= 2 && renderStepCard(step - 1, false)}
      {renderStepCard(step, true)}
      {step <= 1 && renderStepCard(step + 1, false)}
    </div>
  );
});
