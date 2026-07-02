import type * as React from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SECRET_FIELD_SUPPRESSION_PROPS } from "./secret-input.utils";

type SecretInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  // Render the value as dots (see .secret-masked in globals.css). Turn off
  // for fields whose sensitivity is caller-controlled (e.g. a "sensitive"
  // switch) or that were never masked.
  masked?: boolean;
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
  className,
  onCopy,
  onCut,
  ...props
}: SecretInputProps) {
  return (
    <Input
      type="text"
      className={cn(masked && "secret-masked", className)}
      // parity with type="password": a masked value cannot be copied or cut
      // out of the field (cut would also delete the selection)
      onCopy={(e) => {
        if (masked) e.preventDefault();
        onCopy?.(e);
      }}
      onCut={(e) => {
        if (masked) e.preventDefault();
        onCut?.(e);
      }}
      {...props}
      {...SECRET_FIELD_SUPPRESSION_PROPS}
    />
  );
}

// Textarea for multiline app secrets (PEM keys, secret file contents). These
// were never visually masked; the point is the suppression attributes.
function SecretTextarea(props: React.ComponentProps<"textarea">) {
  return <Textarea {...props} {...SECRET_FIELD_SUPPRESSION_PROPS} />;
}

export { SecretInput, SecretTextarea };
