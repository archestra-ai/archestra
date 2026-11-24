"use client";

import {
  CLIENT_FILTER_OPTIONS,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
} from "@archestra/shared";
import { Check, ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { filterControlClass } from "@/components/filter-bar";
import {
  ClientFilterOption,
  SourceFilterOption,
} from "@/components/log-filter-option";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { matchesSearchTokens } from "@/lib/search-tokens";

/** Discover both attribution dimensions together while keeping their filters independent. */
export function OriginFilter({
  client,
  source,
  onClientChange,
  onSourceChange,
}: {
  client: string;
  source: string;
  onClientChange: (value: string) => void;
  onSourceChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const labels = [
    client !== "all" &&
      (CLIENT_FILTER_OPTIONS.find(({ value }) => value === client)?.label ??
        client),
    source !== "all" &&
      (INTERACTION_SOURCE_DISPLAY[source as InteractionSource]?.label ??
        source),
  ].filter(Boolean);
  const choose = (onChange: (value: string) => void, value: string) => {
    onChange(value);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-label="Filter by apps and sources"
          aria-description={
            labels.length ? labels.join(", ") : "All apps and request sources"
          }
          title={labels.length ? labels.join(" · ") : undefined}
          aria-expanded={open}
          aria-controls={open ? popupId : undefined}
          aria-haspopup="dialog"
          className={filterControlClass({ active: labels.length > 0 })}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="truncate">
            {labels.length ? labels.join(" · ") : "All apps & sources"}
          </span>
          <ChevronDown aria-hidden className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={popupId}
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
      >
        <Command
          filter={(_value, search, keywords) =>
            matchesSearchTokens(search, keywords ?? []) ? 1 : 0
          }
        >
          <CommandInput
            placeholder="Search apps and sources…"
            aria-label="Search apps and sources"
          />
          <div className="space-y-1 px-3 py-2 text-xs text-muted-foreground">
            <p>
              <span className="font-medium">App:</span> the tool, like Claude
              Code.
            </p>
            <p>
              <span className="font-medium">Source:</span> the origin or task,
              like API or title generation.
            </p>
          </div>
          <CommandList>
            <CommandEmpty>No apps or sources found.</CommandEmpty>
            <CommandGroup heading="Client apps">
              <CommandItem
                aria-label="All client apps"
                aria-description={client === "all" ? "Applied" : undefined}
                value="client:all"
                keywords={["All client apps"]}
                onSelect={() => choose(onClientChange, "all")}
              >
                <span>All client apps</span>
                {client === "all" && (
                  <Check aria-hidden className="ml-auto size-4" />
                )}
              </CommandItem>
              {CLIENT_FILTER_OPTIONS.map((option) => (
                <CommandItem
                  key={option.value}
                  aria-label={option.label}
                  aria-description={
                    client === option.value ? "Applied" : undefined
                  }
                  value={`client:${option.value}`}
                  keywords={[option.label]}
                  onSelect={() => choose(onClientChange, option.value)}
                >
                  <ClientFilterOption client={option} />
                  {client === option.value && (
                    <Check aria-hidden className="ml-auto size-4" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Request sources">
              <CommandItem
                aria-label="All request sources"
                aria-description={source === "all" ? "Applied" : undefined}
                value="source:all"
                keywords={["All request sources"]}
                onSelect={() => choose(onSourceChange, "all")}
              >
                <span>All request sources</span>
                {source === "all" && (
                  <Check aria-hidden className="ml-auto size-4" />
                )}
              </CommandItem>
              {Object.entries(INTERACTION_SOURCE_DISPLAY).map(
                ([value, { label }]) => (
                  <CommandItem
                    key={value}
                    aria-label={label}
                    aria-description={source === value ? "Applied" : undefined}
                    value={`source:${value}`}
                    keywords={[label]}
                    onSelect={() => choose(onSourceChange, value)}
                  >
                    <SourceFilterOption source={value as InteractionSource} />
                    {source === value && (
                      <Check aria-hidden className="ml-auto size-4" />
                    )}
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
