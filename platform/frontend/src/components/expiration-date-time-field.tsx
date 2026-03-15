"use client";

import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Label } from "@/components/ui/label";

export function ExpirationDateTimeField({
  value,
  onChange,
  label = "Expiration",
  placeholder = "No expiration",
  noExpirationText = "Will never expire",
  formatExpiration,
}: {
  value: Date | null;
  onChange: (value: Date | null) => void;
  label?: string;
  placeholder?: string;
  noExpirationText?: string;
  formatExpiration: (value: Date | string | null) => string;
}) {
  return (
    <div className="space-y-2">
      <Label>
        {label}{" "}
        <span className="text-muted-foreground font-normal">
          ({Intl.DateTimeFormat().resolvedOptions().timeZone})
        </span>
      </Label>
      <div className="flex items-center gap-2">
        <DateTimePicker
          value={value ?? undefined}
          onChange={(date) => onChange(date ?? null)}
          disabledDate={(date) => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            return date < today;
          }}
          placeholder={placeholder}
          className="flex-1"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
          >
            Never
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {value ? `Expires ${formatExpiration(value)}` : noExpirationText}
      </p>
    </div>
  );
}
