import type { ComponentProps } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { cn } from "@/lib/utils";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({
  className,
  resize = "smooth",
  ...props
}: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-auto", className)}
    initial="instant"
    resize={resize}
    role="log"
    {...props}
  />
);
