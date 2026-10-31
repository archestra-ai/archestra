"use client";

import { Slot } from "@radix-ui/react-slot";
import * as React from "react";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils/tailwind";

/** Label, help, control and error for fields outside React Hook Form.
 * Inside an RHF form use FormItem/FormLabel/FormDescription/FormControl/FormMessage.
 * Put FieldControl around the focusable input or SelectTrigger, including when
 * it is nested inside an InputGroup or Select.
 */
export function Field({
  id,
  label,
  description,
  error,
  children,
  labelClassName,
  className,
}: {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  labelClassName?: string;
  className?: string;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <FieldContext.Provider
      value={{ id, descriptionId, errorId, invalid: !!error }}
    >
      <div className={cn("grid gap-2", className)}>
        <Label htmlFor={id} className={labelClassName}>
          {label}
        </Label>
        {description && (
          <FieldDescription id={descriptionId}>{description}</FieldDescription>
        )}
        {children}
        {error && (
          <p id={errorId} className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export function FieldControl({
  "aria-describedby": describedBy,
  ...props
}: React.ComponentProps<typeof Slot>) {
  const field = React.useContext(FieldContext);
  if (!field) throw new Error("FieldControl must be used within Field");
  return (
    <Slot
      {...props}
      id={field.id}
      aria-describedby={
        [describedBy, field.descriptionId, field.errorId]
          .filter(Boolean)
          .join(" ") || undefined
      }
      aria-invalid={field.invalid || undefined}
    />
  );
}

const FieldContext = React.createContext<{
  id: string;
  descriptionId?: string;
  errorId?: string;
  invalid: boolean;
} | null>(null);
