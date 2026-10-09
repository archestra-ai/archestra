"use client";

import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils/tailwind";

export function ConnectionConsentOptions({
  open,
  onOpenChange,
  gateway,
  proxy,
  skills,
  plugins,
  platform,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateway: ReactNode;
  proxy: ReactNode;
  skills: ReactNode;
  plugins: ReactNode;
  platform: ReactNode;
}) {
  const sections = [
    { title: "Tools", content: gateway },
    { title: "Model routing", content: proxy },
    { title: "Skills", content: skills },
    { title: "Plugins", content: plugins },
    { title: "Platform", content: platform },
  ];

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="mb-4 overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 sm:px-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <SlidersHorizontal
            aria-hidden
            className="size-4 text-muted-foreground"
          />
          <h2>Setup options</h2>
        </div>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            <span>{open ? "Done customizing" : "Customize setup"}</span>
            <ChevronDown
              aria-hidden
              className={cn("size-4", open && "rotate-180")}
            />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="border-t">
        <div className="space-y-5 p-5 sm:p-6">
          <div className="divide-y">
            {sections
              .filter((section) => section.content)
              .map((section) => (
                <section
                  key={section.title}
                  className="grid min-w-0 gap-3 py-5 first:pt-0 last:pb-0 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-5"
                >
                  <h3 className="text-sm font-medium">{section.title}</h3>
                  <div className="min-w-0 space-y-3 [&_label]:items-start [&_label]:leading-relaxed [&_[data-slot=checkbox]]:mt-1">
                    {section.content}
                  </div>
                </section>
              ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
