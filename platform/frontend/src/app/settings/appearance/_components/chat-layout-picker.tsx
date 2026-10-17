"use client";

import { Bot, Check, CornerDownLeft, Paperclip } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ChatLanding, type ChatLandingStyle } from "@/app/chat/chat-landing";
import {
  type SuggestedPrompt,
  SuggestedPromptPills,
} from "@/app/chat/suggested-prompt-pills";
import { AppLogo } from "@/components/app-logo";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils/tailwind";

export function ChatLayoutPicker({
  value,
  animateHeadline,
  onChange,
  onAnimateHeadlineChange,
}: {
  value: ChatLandingStyle;
  animateHeadline: boolean;
  onChange: (value: ChatLandingStyle) => void;
  onAnimateHeadlineChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label id={`${id}-label`}>New chat layout</Label>
        <FieldDescription id={`${id}-description`}>
          How an empty chat greets people.
        </FieldDescription>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {LAYOUTS.map((layout) => {
          const selected = layout.id === value;
          return (
            <UnstyledButton
              key={layout.id}
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(layout.id)}
              className={cn(
                "group relative flex flex-col gap-3 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
                selected
                  ? "border-primary bg-primary/[0.04] ring-1 ring-primary"
                  : "hover:border-foreground/25",
              )}
            >
              <span
                className={cn(
                  "absolute top-2.5 right-2.5 flex size-4 items-center justify-center rounded-full border transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-foreground/20",
                )}
              >
                {selected && <Check className="size-3" strokeWidth={3} />}
              </span>
              <layout.Sketch />
              <span>
                <span className="block text-sm font-medium">
                  {layout.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {layout.description}
                </span>
              </span>
            </UnstyledButton>
          );
        })}
      </div>
      {value === "greeting" && (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-animate`}>Animate headline</Label>
            <FieldDescription id={`${id}-animate-description`}>
              Cycle the second line through the agent's suggested prompts.
            </FieldDescription>
          </div>
          <Switch
            id={`${id}-animate`}
            checked={animateHeadline}
            onCheckedChange={onAnimateHeadlineChange}
            aria-describedby={`${id}-animate-description`}
          />
        </div>
      )}
      <LayoutPreview layout={value} animateHeadline={animateHeadline} />
    </div>
  );
}

// ===

/**
 * The real new-chat layout, zoomed out, with sample suggestions and a stand-in
 * composer. Rendered in the app itself, so it follows the active theme and
 * light/dark mode. Hovering a suggestion previews its prompt, as on /chat.
 */
function LayoutPreview({
  layout,
  animateHeadline,
}: {
  layout: ChatLandingStyle;
  animateHeadline: boolean;
}) {
  const { data: session } = useSession();
  const [preview, setPreview] = useState<string | null>(null);
  const composer = <PreviewComposer text={preview} />;
  return (
    <div className="space-y-2">
      <Label>Preview</Label>
      <div
        aria-hidden="true"
        className="h-[260px] overflow-hidden rounded-lg border bg-background"
      >
        <div
          className="flex flex-col"
          style={{ zoom: PREVIEW_ZOOM, height: 260 / PREVIEW_ZOOM }}
        >
          {layout === "classic" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-8 p-4">
              <div className="scale-150">
                <AppLogo />
              </div>
              <SuggestedPromptPills
                prompts={SAMPLE_PROMPTS}
                onPreviewChange={setPreview}
                onSelect={() => setPreview(null)}
              />
              <div className="w-full max-w-4xl">{composer}</div>
            </div>
          ) : (
            <ChatLanding
              key={layout}
              layout={layout}
              animateHeadline={animateHeadline}
              userName={session?.user?.name}
              composer={composer}
              prompts={SAMPLE_PROMPTS}
              onPreviewChange={setPreview}
              onSelectPrompt={() => setPreview(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewComposer({ text }: { text: string | null }) {
  return (
    <div className="rounded-md border bg-background shadow-xs dark:bg-input/30">
      <div className="truncate px-3 pt-3 pb-9 text-sm text-muted-foreground">
        {text ?? "What would you like to get done?"}
      </div>
      <div className="flex items-center gap-3 px-3 pb-3 text-sm text-muted-foreground">
        <Paperclip className="size-4" />
        <span className="flex items-center gap-1.5">
          <Bot className="size-4" />
          <span>Assistant</span>
        </span>
        <span className="ml-auto flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <CornerDownLeft className="size-4" />
        </span>
      </div>
    </div>
  );
}

function ClassicSketch() {
  return (
    <SketchFrame className="items-center justify-center gap-1.5">
      <span className="size-3 rounded-sm bg-foreground/40" />
      <span className="flex gap-1">
        <Bar className="w-5 rounded-full border border-foreground/25 bg-transparent" />
        <Bar className="w-6 rounded-full border border-foreground/25 bg-transparent" />
        <Bar className="w-5 rounded-full border border-foreground/25 bg-transparent" />
      </span>
      <Composer />
    </SketchFrame>
  );
}

function GreetingSketch() {
  return (
    <SketchFrame className="justify-center gap-1">
      <Bar className="h-2 w-16 bg-foreground/60" />
      <Bar className="h-2 w-12 bg-foreground/25" />
      <Composer className="mt-1" />
      <span className="flex gap-1.5">
        <Bar className="w-6" />
        <Bar className="w-7" />
        <Bar className="w-5" />
      </span>
    </SketchFrame>
  );
}

function GlanceSketch() {
  return (
    <SketchFrame className="justify-center gap-1">
      <Bar className="h-2 w-16 bg-foreground/60" />
      <Bar className="h-2 w-12 bg-foreground/25" />
      <Composer className="mt-1" />
      <span className="grid grid-cols-3 gap-1">
        <span className="h-3 rounded-sm bg-foreground/10" />
        <span className="h-3 rounded-sm bg-foreground/10" />
        <span className="h-3 rounded-sm bg-foreground/10" />
      </span>
    </SketchFrame>
  );
}

function SketchFrame({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex h-24 flex-col rounded-md bg-muted/50 px-6 transition-colors group-hover:bg-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

function Bar({ className }: { className?: string }) {
  return (
    <span
      className={cn("block h-1.5 rounded-full bg-foreground/15", className)}
    />
  );
}

function Composer({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block h-4 w-full rounded-sm border border-foreground/20 bg-background",
        className,
      )}
    />
  );
}

const PREVIEW_ZOOM = 0.55;

const LAYOUTS: {
  id: ChatLandingStyle;
  label: string;
  description: string;
  Sketch: () => ReactNode;
}[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Logo, suggestion pills, then the input.",
    Sketch: ClassicSketch,
  },
  {
    id: "greeting",
    label: "Greeting",
    description: "A time-of-day greeting with quiet suggestions.",
    Sketch: GreetingSketch,
  },
  {
    id: "glance",
    label: "Glance",
    description: "Greeting plus tiles that preview each prompt.",
    Sketch: GlanceSketch,
  },
];

const SAMPLE_PROMPTS: SuggestedPrompt[] = [
  {
    summaryTitle: "Plan a project",
    prompt:
      "Help me plan a project: break it into milestones, tasks, owners and a rough timeline.",
  },
  {
    summaryTitle: "Explain a concept",
    prompt:
      "Explain a concept to me simply, then go one level deeper with an example.",
  },
  {
    summaryTitle: "Draft a message",
    prompt:
      "Draft a clear, friendly message I can send to my team about an update.",
  },
  {
    summaryTitle: "Brainstorm ideas",
    prompt:
      "Brainstorm ten distinct ideas, then pick the three strongest and say why.",
  },
  {
    summaryTitle: "Summarize text",
    prompt: "Summarize the following text into key points and action items.",
  },
];
