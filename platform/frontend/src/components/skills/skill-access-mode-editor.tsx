"use client";

import type { ReactNode } from "react";
import {
  AccessModeCards,
  type AccessModeOption,
} from "@/components/access-mode-cards";

export type SkillAccessMode = "all" | "manual";

interface SkillAccessModeEditorProps {
  mode: SkillAccessMode;
  onModeChange: (mode: SkillAccessMode) => void;
  /** What "All skills" covers here, such as every skill the person can use. */
  allRule: string;
  allStat?: string;
  manualStat?: string;
  availableSkillsView?: ReactNode;
  allEditor: ReactNode;
  manualEditor: ReactNode;
}

/** The common All/blocklist and Manual/allowlist interaction. */
export function SkillAccessModeEditor({
  mode,
  onModeChange,
  allRule,
  allStat,
  manualStat,
  availableSkillsView,
  allEditor,
  manualEditor,
}: SkillAccessModeEditorProps) {
  const all: AccessModeOption = {
    title: "All skills",
    rule: allRule,
    stat: allStat,
  };
  const manual: AccessModeOption = {
    title: "Manual",
    rule: "Only the skills you pick. New skills stay off.",
    stat: manualStat,
  };
  return (
    <div className="space-y-3">
      <AccessModeCards
        label="Skill access"
        mode={mode}
        onModeChange={onModeChange}
        all={all}
        manual={manual}
        footnote={mode === "all" ? availableSkillsView : null}
      />
      {mode === "all" ? allEditor : manualEditor}
    </div>
  );
}
