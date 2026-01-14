import { Check, Copy, Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-md border bg-background/95 shadow-sm p-0.5",
        className,
      )}
    >
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 hover:bg-muted"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 hover:bg-muted"
        onClick={onEditClick}
        disabled={editDisabled}
      >
        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="sr-only">Edit</span>
      </Button>
    </div>
  );
}
