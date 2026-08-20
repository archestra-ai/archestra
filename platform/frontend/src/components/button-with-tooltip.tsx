import {
  type ComponentProps,
  isValidElement,
  type ReactNode,
  useId,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * `disabledText` is required alongside `disabled` so this component cannot
 * render a refused control with nothing to explain it.
 */
type ButtonWithTooltipProps = ComponentProps<typeof Button> &
  (
    | { disabled: boolean; disabledText: string }
    | { disabled?: false; disabledText?: never }
  );

export function ButtonWithTooltip({
  disabled,
  disabledText,
  children,
  ...props
}: ButtonWithTooltipProps) {
  const reasonId = useId();

  if (!disabled) {
    return <Button {...props}>{children}</Button>;
  }

  // `asChild` belongs to the enabled rendering only: the refused button holds
  // two children, which is one more than Radix's Slot accepts. There is nothing
  // to navigate to when the action is refused either, so only the slot child's
  // content survives; the link itself does not.
  const { asChild, ...rest } = props;
  const content =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children.props.children
      : children;

  // `aria-disabled` rather than `disabled`: a disabled button swallows pointer
  // events, so the tooltip naming the reason could only open from a wrapper
  // element, never from the control the user is actually pointing at.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            {...rest}
            type="button"
            aria-disabled="true"
            aria-describedby={reasonId}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {content}
            {/* The reason as text, not only as a tooltip: keyboard and screen
                reader users never open one. `aria-hidden` keeps it out of the
                accessible name, where it would duplicate the description a
                screen reader already reads from `aria-describedby`. */}
            <span id={reasonId} aria-hidden="true" className="sr-only">
              {disabledText}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{disabledText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
