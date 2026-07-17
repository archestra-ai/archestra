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
  minDate,
  maxDate,
}: {
  value: Date | null;
  onChange: (value: Date | null) => void;
  label?: string;
  placeholder?: string;
  noExpirationText?: string;
  formatExpiration: (value: Date | string | null) => string;
  minDate?: Date;
  maxDate?: Date;
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
            if (date < today) return true;
            if (minDate) {
              const min = new Date(minDate);
              min.setHours(0, 0, 0, 0);
              if (date < min) return true;
            }
            if (maxDate) {
              const max = new Date(maxDate);
              max.setHours(0, 0, 0, 0);
              if (date > max) return true;
            }
            return false;
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
