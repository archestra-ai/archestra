import { Check, CircleDashed } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One setup-review line: status, summary, and an optional inline editor using
 * the same collapsed Change/Done interaction across connection surfaces.
 */
export function SetupSummaryRow({
  children,
  done = true,
  editable = false,
  isEditing = false,
  onToggle,
  editor,
  changeTestId,
  detail,
}: {
  children: ReactNode;
  done?: boolean;
  editable?: boolean;
  isEditing?: boolean;
  onToggle?: () => void;
  editor?: ReactNode;
  changeTestId?: string;
  detail?: ReactNode;
}) {
  return (
    <li className="text-sm text-muted-foreground">
      <div className="flex items-start gap-2">
        {done ? (
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        ) : (
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
        )}
        <span>
          {children}
          {editable && (
            <>
              {" "}
              <button
                type="button"
                onClick={onToggle}
                data-testid={changeTestId}
                className="text-xs text-muted-foreground/70 hover:text-foreground hover:underline"
              >
                {isEditing ? "Done" : "Change"}
              </button>
            </>
          )}
        </span>
      </div>
      {detail && <div className="ml-6 mt-1.5">{detail}</div>}
      {isEditing && editor && (
        // A rail, not a box: the editor reads as an inline expansion of its
        // row rather than a form card dropped into the list.
        <div className="ml-6 mt-2 max-w-lg border-l-2 border-border/70 py-1 pl-4">
          {editor}
        </div>
      )}
    </li>
  );
}
