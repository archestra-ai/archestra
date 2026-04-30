import { ArrowDownIcon } from "lucide-react";
import { type ComponentProps, useCallback } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConversationScrollButtonProps = ComponentProps<typeof Button> & {
  label?: string;
};

export const ConversationScrollButton = ({
  className,
  label,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full",
          label && "h-9 gap-1.5 px-4",
          className,
        )}
        onClick={handleScrollToBottom}
        size={label ? "default" : "icon"}
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
        {label && <span className="text-sm">{label}</span>}
      </Button>
    )
  );
};
