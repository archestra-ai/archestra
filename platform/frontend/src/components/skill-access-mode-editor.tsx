"use client";

import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type SkillAccessMode = "all" | "manual";

interface SkillAccessModeEditorProps {
  mode: SkillAccessMode;
  onModeChange: (mode: SkillAccessMode) => void;
  summary: ReactNode;
  availableSkillsView?: ReactNode;
  allEditor: ReactNode;
  manualEditor: ReactNode;
}

/** The common All/blocklist and Manual/allowlist interaction. */
export function SkillAccessModeEditor({
  mode,
  onModeChange,
  summary,
  availableSkillsView,
  allEditor,
  manualEditor,
}: SkillAccessModeEditorProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <p>{summary}</p>
          {mode === "all" && availableSkillsView}
        </div>
        <Tabs
          value={mode}
          onValueChange={(value) =>
            onModeChange(value === "all" ? "all" : "manual")
          }
        >
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="manual">Manual</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {mode === "all" ? allEditor : manualEditor}
    </div>
  );
}
