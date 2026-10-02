"use client";

import { Gauge } from "lucide-react";
import { useState } from "react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils/tailwind";
import { countTools, ProtoPage, ProtoSection } from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Rough per-item sizes for the mock; real numbers would come from schemas.
const TOKENS_PER_TOOL = 180;
const DISCOVERY_TOKENS = 900;
const TOKENS_PER_SKILL_DESCRIPTION = 60;
const CONTEXT_WINDOW = 200_000;

// Avenue E: answer "will it burn my context?" with honest numbers and a mode.
export default function ContextImpactVariant({
  scenario,
}: PrototypeVariantProps) {
  const fullTokens = countTools(scenario) * TOKENS_PER_TOOL;
  const skillTokens = scenario.skills.length * TOKENS_PER_SKILL_DESCRIPTION;
  const [mode, setMode] = useState<"discovery" | "full">(
    fullTokens > 20_000 ? "discovery" : "full",
  );
  const options = [
    {
      id: "discovery" as const,
      title: "Discovery mode",
      body: "Your agent sees a small search tool and loads tools when it needs them.",
      tokens: DISCOVERY_TOKENS,
    },
    {
      id: "full" as const,
      title: "Full tool list",
      body: "Every tool is listed up front. Fastest for small setups.",
      tokens: fullTokens,
    },
  ];

  return (
    <ProtoPage
      title="How much of your agent's memory will this use?"
      subtitle="These are tool definitions loaded into each conversation, not a cost."
    >
      <ProtoSection title="Tools">
        <div className="grid gap-3 md:grid-cols-2">
          {options.map((option) => (
            <button
              type="button"
              key={option.id}
              onClick={() => setMode(option.id)}
              className={cn(
                "flex flex-col gap-2 rounded-lg border bg-card p-4 text-left",
                mode === option.id && "border-primary ring-4 ring-primary/5",
              )}
            >
              <div className="font-medium">{option.title}</div>
              <div className="text-sm text-muted-foreground">{option.body}</div>
              <div className="flex items-center gap-2 text-sm">
                <Gauge className="size-4" />
                <span>~{option.tokens.toLocaleString()} tokens</span>
              </div>
              <Progress
                value={Math.min(100, (option.tokens / CONTEXT_WINDOW) * 100)}
              />
              <div className="text-xs text-muted-foreground">
                {((option.tokens / CONTEXT_WINDOW) * 100).toFixed(1)}% of a 200k
                context window
              </div>
            </button>
          ))}
        </div>
      </ProtoSection>
      <ProtoSection
        title="Skills"
        description={`Only short descriptions load until a skill is used: ~${skillTokens.toLocaleString()} tokens for ${scenario.skills.length} skills.`}
      />
    </ProtoPage>
  );
}
