import type { ComponentProps } from "react";
import type { Editor } from "@/components/editor";

/** Shared source-view settings; callers supply their own access and label. */
export const POLICY_EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 14,
  lineNumbers: "on",
  scrollBeyondLastLine: false,
  wordWrap: "on",
  padding: { top: 16, bottom: 16 },
  automaticLayout: true,
} satisfies ComponentProps<typeof Editor>["options"];
