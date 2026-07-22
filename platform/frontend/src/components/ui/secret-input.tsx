import { Eye, EyeOff } from "lucide-react";
import type * as React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SECRET_FIELD_SUPPRESSION_PROPS } from "./secret-input.utils";

type SecretInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  // Render the value as dots (see .secret-masked in globals.css). Turn off
  // for fields whose sensitivity is caller-controlled (e.g. a "sensitive"
  // switch) or that were never masked.
  masked?: boolean;
  // Render an "eye" toggle that reveals/hides the masked value. Off by default
  // so existing secret fields are unaffected; opt in where the user needs to
  // verify what they typed or pasted (e.g. the Add API Key form).
  revealable?: boolean;
};

// Input for app secrets (API keys, tokens, client secrets). Always renders
// type="text" with password-manager suppression attributes; see
// secret-input.utils.ts for why type="password" must not be used here. Real
// user-credential fields (login, change password, 2FA) must keep native
// password inputs instead of this component.
// The suppression attributes are spread AFTER {...props} on purpose: a caller
// must not be able to reintroduce autofill on a secret field.
function SecretInput({
  masked = true,
  revealable = false,
  className,
  disabled,
  onCopy,
  onCut,
  ...props
}: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);
  // Revealing turns off masking, which also lifts the copy/cut guards below so
  // the user can copy a value they've chosen to see.
  const effectiveMasked = masked && !revealed;

  const input = (
    <Input
      type="text"
      disabled={disabled}
      className={cn(
        effectiveMasked && "secret-masked",
        revealable && "pr-10",
        className,
      )}
      // parity with type="password": a masked value cannot be copied or cut
      // out of the field (cut would also delete the selection)
      onCopy={(e) => {
        if (effectiveMasked) e.preventDefault();
        onCopy?.(e);
      }}
      onCut={(e) => {
        if (effectiveMasked) e.preventDefault();
        onCut?.(e);
      }}
      {...props}
      {...SECRET_FIELD_SUPPRESSION_PROPS}
    />
  );

  if (!revealable) {
    return input;
  }

  return (
    <div className="relative">
      {input}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => setRevealed((value) => !value)}
        className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
        title={revealed ? "Hide value" : "Show value"}
      >
        {revealed ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
        <span className="sr-only">
          {revealed ? "Hide value" : "Show value"}
        </span>
      </Button>
    </div>
  );
}

// Textarea for multiline app secrets (PEM keys, secret file contents). These
// were never visually masked; the point is the suppression attributes.
function SecretTextarea(props: React.ComponentProps<"textarea">) {
  return <Textarea {...props} {...SECRET_FIELD_SUPPRESSION_PROPS} />;
}

export { SecretInput, SecretTextarea };
