import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SetupStep({
  title,
  description,
  done,
  ctaLabel,
  onAction,
  doneActionLabel,
  onDoneAction,
  children,
}: {
  title: string;
  description: string;
  done: boolean;
  ctaLabel: string;
  onAction?: () => void;
  doneActionLabel?: string;
  onDoneAction?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Card className="py-3 gap-0">
      <CardHeader className="px-4 gap-0">
        <div
          className={cn(
            "flex items-center justify-between gap-4",
            children && "pb-2 border-b",
          )}
        >
          <CardTitle>
            <div className="flex items-center gap-4">
              {done ? (
                <CheckCircle2 className="size-5 shrink-0 text-green-500" />
              ) : (
                <Circle className="text-muted-foreground size-5 shrink-0" />
              )}
              <div className="flex flex-col gap-1">
                <div className="font-medium text-sm">{title}</div>
                <div className="text-muted-foreground text-xs font-normal">
                  {description}
                </div>
              </div>
            </div>
          </CardTitle>
          <div className="shrink-0">
            {done && onDoneAction ? (
              <Button
                variant="outline"
                onClick={onDoneAction}
                size="sm"
                className="text-xs"
              >
                {doneActionLabel}
              </Button>
            ) : !done && onAction ? (
              <Button
                variant="outline"
                onClick={onAction}
                size="sm"
                className="text-xs"
              >
                {ctaLabel}
              </Button>
            ) : !done ? (
              <span className="text-muted-foreground text-sm">{ctaLabel}</span>
            ) : null}
          </div>
        </div>
      </CardHeader>
      {children && (
        <CardContent className="text-xs text-muted-foreground px-4 mt-2">
          {children}
        </CardContent>
      )}
    </Card>
  );
}
