"use client";

import { useId } from "react";
import { ExpirySelect } from "@/components/credential-billing/expiry-select";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";

export function ExpirationDateTimeField({
  value,
  onChange,
  label = "Expiration",
  noExpirationText = "Will never expire",
  formatExpiration,
  disabledDate = isPastDate,
}: {
  value: Date | null;
  onChange: (value: Date | null) => void;
  label?: string;
  placeholder?: string;
  noExpirationText?: string;
  formatExpiration: (value: Date | string | null) => string;
  disabledDate?: (date: Date) => boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}{" "}
        <span className="text-muted-foreground font-normal">
          ({Intl.DateTimeFormat().resolvedOptions().timeZone})
        </span>
      </Label>
      <ExpirySelect
        id={id}
        value={value}
        onChange={onChange}
        disabledDate={disabledDate}
      />
      <FieldDescription>
        {value ? `Expires ${formatExpiration(value)}` : noExpirationText}
      </FieldDescription>
    </div>
  );
}

function isPastDate(date: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}
