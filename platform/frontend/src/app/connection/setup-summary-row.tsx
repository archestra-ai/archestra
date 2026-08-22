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
        <div className="ml-6 mt-2 max-w-md rounded-lg border bg-muted/20 p-3">
          {editor}
        </div>
      )}
    </li>
  );
}
