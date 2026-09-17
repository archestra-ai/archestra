import { Github, Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

export function GitHubConnectButton({
  pending = false,
  label = "Connect GitHub",
  disabled,
  ...props
}: Omit<ButtonProps, "children"> & { pending?: boolean; label?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || pending}
      {...props}
    >
      {pending ? (
        <Loader2
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <Github className="size-4" strokeWidth={1.5} aria-hidden="true" />
      )}
      <span>{pending ? "Connecting…" : label}</span>
    </Button>
  );
}
