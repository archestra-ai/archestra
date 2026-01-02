import { Pencil } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";

export function MessageActions({
  textToCopy,
  onEditClick,
  className,
  editDisabled = false,
}: {
  className?: string;
  textToCopy: string;
  onEditClick: () => void;
  editDisabled?: boolean;
}) {
  return (
    <div className={`flex gap-1 ${className ?? ""}`}>
      <CopyButton
        text={textToCopy}
        buttonSize="icon"
        size={12}
        className="text-muted-foreground hover:bg-transparent"
      />
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 p-0 hover:bg-transparent group/edit"
        onClick={onEditClick}
        disabled={editDisabled}
      >
        <Pencil className="h-3 w-3 text-muted-foreground group-hover/edit:text-foreground transition-colors" />
        <span className="sr-only">Edit message</span>
      </Button>
    </div>
  );
}
