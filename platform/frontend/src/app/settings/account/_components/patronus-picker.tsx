"use client";

import { useEffect, useMemo, useState } from "react";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PATRONUS_STORAGE_KEY = "archestra-patronus-form";
const PATRONUS_FORMS = ["otter", "stag", "doe", "hare", "lynx", "swan"];

export function PatronusPicker() {
  const [selectedForm, setSelectedForm] = useState(PATRONUS_FORMS[0]);

  useEffect(() => {
    const stored = localStorage.getItem(PATRONUS_STORAGE_KEY);
    if (stored && PATRONUS_FORMS.includes(stored)) {
      setSelectedForm(stored);
    }
  }, []);

  const path = useMemo(() => getPatronusPath(selectedForm), [selectedForm]);

  const handleSelect = (form: string) => {
    setSelectedForm(form);
    localStorage.setItem(PATRONUS_STORAGE_KEY, form);
  };

  return (
    <Card>
      <SettingsCardHeader
        title="Patronus"
        description="Choose the Patronus form shown during governed MCP tool authorization."
      />
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="relative grid size-20 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40">
            <div className="absolute h-12 w-12 animate-ping rounded-full bg-primary/15" />
            <svg
              aria-label={`${selectedForm} Patronus animation`}
              className="relative h-12 w-12 text-primary drop-shadow"
              viewBox="0 0 64 64"
            >
              <path d={path} fill="currentColor" opacity="0.9" />
            </svg>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
            {PATRONUS_FORMS.map((form) => (
              <Button
                key={form}
                type="button"
                variant={selectedForm === form ? "default" : "outline"}
                className={cn("justify-center capitalize")}
                onClick={() => handleSelect(form)}
              >
                {form}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function getPatronusPath(form: string): string {
  switch (form) {
    case "stag":
      return "M11 42c8-18 15-21 25-15l9-12 2 14 10-1-8 8c3 9-1 16-10 17-8 1-14-3-18-11l-8 7-2-7Z";
    case "doe":
      return "M10 43c7-16 17-21 30-13l8-8 1 11 8 1-8 6c0 9-6 14-15 14-8 0-13-4-16-12l-6 6-2-5Z";
    case "hare":
      return "M9 43c6-10 15-12 24-8l11-24 1 25 12-7-8 15c-5 9-16 11-26 7l-9 6-5-14Z";
    case "lynx":
      return "M10 42c8-13 19-17 31-11l4-13 5 12 8-2-6 10c3 12-7 20-22 18-10-2-16-6-20-14Z";
    case "swan":
      return "M8 43c12 7 25 5 34-6 5-6 1-14-5-11-4 2-4 8 1 11-12 2-20-2-24-10 4 2 8 3 12 1-5 9-11 14-18 15Z";
    default:
      return "M9 42c7-15 18-20 31-12l8-9 1 12 8 2-8 6c0 10-8 15-20 14-9-1-16-5-20-13Z";
  }
}
