import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PolicyCard({
  children,
  onDelete,
}: {
  children: React.ReactNode;
  onDelete: () => void;
}) {
  return (
    <div className="mt-2 bg-muted/50 border border-border rounded-md flex flex-row min-h-[60px] overflow-hidden">
      <div className="flex-1 p-4">{children}</div>
      <div className="w-10 shrink-0 bg-muted flex items-center justify-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="group hover:bg-destructive/20 dark:hover:bg-destructive/20"
          onClick={onDelete}
          aria-label="Delete policy"
        >
          <Trash2Icon className="w-4 h-4 text-muted-foreground group-hover:text-destructive transition-colors" />
        </Button>
      </div>
    </div>
  );
}
