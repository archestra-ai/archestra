import type { OnMount } from "@monaco-editor/react";
import type {
  PolicyBattery,
  PolicyDeclarations,
} from "@/lib/openappa-batteries.query";
import { BATTERY_STATUS } from "./battery-status";

type BatteryStatus = PolicyBattery["status"];

/** How a battery's status reads wherever it is shown: a badge, an editor hover. */
export function batteryStatusBadge(status: BatteryStatus): {
  label: string;
  variant: "secondary" | "outline" | "destructive";
} {
  const { label, severity } = BATTERY_STATUS[status];
  return {
    label,
    variant:
      severity === "ok"
        ? "secondary"
        : severity === "warning"
          ? "outline"
          : "destructive",
  };
}

export type PolicyAnnotation =
  | { kind: "battery"; line: number; name: string; status: BatteryStatus }
  | { kind: "unusedAlias"; line: number; namespace: string };

/**
 * What the saved policy text has to say about itself, line by line: every
 * `include` entry with the battery it pulled in, every alias no included
 * battery declares. Ordered by line, which is the order the reader meets them.
 *
 * The lines come from the revision the declarations were read at, so the
 * caller must only show these while the editor still holds that exact text.
 *
 * A composition that failed enforces no battery, whatever each entry's own
 * status says, so every entry then reads as refused — as the panel shows it.
 */
export function policyAnnotations(
  declarations: PolicyDeclarations,
): PolicyAnnotation[] {
  const enforced = declarations.lastError === null;
  const batteries = declarations.batteries.map(
    ({ line, name, status }): PolicyAnnotation => ({
      kind: "battery",
      line,
      name,
      status: enforced ? status : "refused",
    }),
  );
  const aliases = declarations.unusedAliases.map(
    ({ line, namespace }): PolicyAnnotation => ({
      kind: "unusedAlias",
      line,
      namespace,
    }),
  );
  return [...batteries, ...aliases].sort((a, b) => a.line - b.line);
}

export function annotationDecorations(
  annotations: PolicyAnnotation[],
): ModelDecoration[] {
  return annotations.map((annotation) => ({
    range: {
      startLineNumber: annotation.line,
      startColumn: 1,
      endLineNumber: annotation.line,
      endColumn: 1,
    },
    options: {
      glyphMarginClassName: isWarning(annotation)
        ? "openappa-glyph-warning"
        : "openappa-glyph-info",
      glyphMarginHoverMessage: { value: annotationMessage(annotation) },
    },
  }));
}

type CodeEditor = Parameters<OnMount>[0];
type ModelDecoration = NonNullable<
  Parameters<CodeEditor["createDecorationsCollection"]>[0]
>[number];

/** Reveal the rule header linked from a tool's policy source. */
export function focusPolicyLine(editor: CodeEditor, line?: number) {
  if (!line || line > (editor.getModel()?.getLineCount() ?? 0)) return;
  editor.revealLineInCenter(line);
  editor.setSelection({
    startLineNumber: line,
    startColumn: 1,
    endLineNumber: line,
    endColumn: editor.getModel()?.getLineMaxColumn(line) ?? 1,
  });
}

function isWarning(annotation: PolicyAnnotation): boolean {
  return annotation.kind === "unusedAlias" || annotation.status !== "active";
}

function annotationMessage(annotation: PolicyAnnotation): string {
  return annotation.kind === "unusedAlias"
    ? "No included battery declares this namespace."
    : `${annotation.name}: ${BATTERY_STATUS[annotation.status].label}`;
}
