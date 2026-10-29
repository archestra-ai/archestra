"use client";

import { getThemeItemById } from "@archestra/shared";
import { Check, ChevronDown, ChevronUp, Info, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { themes } from "@/themes";

type LogoField = "logo" | "logoDark" | "iconLogo" | "iconLogoDark" | "favicon";

export function BrandingAssets({
  values,
  disabled,
  onChange,
}: {
  values: Record<LogoField, string | null>;
  disabled: boolean;
  onChange: (field: LogoField, value: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label id="appearance-assets-label">Logos</Label>
        <FieldDescription id="appearance-assets-description">
          Click an asset to upload or replace it. PNG or SVG, up to 2 MB.
          Favicon accepts PNG only.
        </FieldDescription>
      </div>
      <fieldset
        aria-labelledby="appearance-assets-label"
        aria-describedby="appearance-assets-description"
        className="grid grid-cols-2 gap-3 sm:grid-cols-5"
      >
        {ASSETS.map((asset) => (
          <AssetTile
            key={asset.field}
            {...asset}
            value={values[asset.field]}
            disabled={disabled}
            onChange={(value) => onChange(asset.field, value)}
          />
        ))}
      </fieldset>
    </div>
  );
}

export function BrandingPalette({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const selected = value ?? "caffeine";
  const featuredIds = new Set(
    Array.from(new Set([selected, ...FEATURED_PALETTES])).slice(0, 8),
  );
  const visible = expanded
    ? themes
    : themes.filter((theme) => featuredIds.has(theme.id));
  const selection = themes.find((theme) => theme.id === selected);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label id="appearance-palette-label">Color Theme</Label>
        <FieldDescription id="appearance-palette-description">
          Choose a palette for your organization. Each swatch shows its actual
          theme colors.
        </FieldDescription>
      </div>
      <fieldset
        aria-labelledby="appearance-palette-label"
        aria-describedby="appearance-palette-description"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {visible.map((theme) => {
          const colors = getThemeItemById(theme.id)?.cssVars.light;
          const active = theme.id === selected;
          return (
            <UnstyledButton
              key={theme.id}
              aria-label={theme.name}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(theme.id)}
              className={cn(
                "min-w-0 rounded-md border p-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                active ? "border-primary ring-1 ring-primary" : "border-border",
              )}
            >
              <span
                aria-hidden="true"
                className="mb-2 flex h-4 overflow-hidden rounded-sm"
              >
                {SWATCH_COLORS.map((key) => (
                  <span
                    key={key}
                    className="flex-1"
                    style={{ backgroundColor: colors?.[key] }}
                  />
                ))}
              </span>
              <span className="flex min-w-0 items-center justify-between gap-1">
                <span className="truncate text-xs">{theme.name}</span>
                {active && (
                  <Check aria-hidden="true" className="size-3 shrink-0" />
                )}
              </span>
            </UnstyledButton>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{selection?.name}</span>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp /> : <ChevronDown />}
          <span>
            {expanded
              ? "Show fewer palettes"
              : `Browse all ${themes.length} palettes`}
          </span>
        </Button>
      </div>
    </div>
  );
}

function AssetTile({
  field,
  title,
  hint,
  dark,
  value,
  disabled,
  onChange,
}: {
  field: LogoField;
  title: string;
  hint: string;
  dark?: boolean;
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const isIconField = field.startsWith("icon") || field === "favicon";
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={`appearance-${field}`} className="text-xs">
        {title}
      </Label>
      <FieldDescription id={`appearance-${field}-description`}>
        {hint}
      </FieldDescription>
      <div className="relative">
        <UnstyledButton
          aria-label={`${value ? "Replace" : "Upload"} ${title}`}
          aria-describedby={`appearance-${field}-description`}
          disabled={disabled}
          onClick={() => input.current?.click()}
          className={cn(
            "group relative flex h-14 w-full items-center justify-center overflow-hidden rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            dark ? "bg-zinc-950" : "bg-white",
          )}
        >
          <img
            src={value || (isIconField ? "/logo-icon.svg" : "/logo.svg")}
            alt=""
            className={cn(
              "object-contain",
              isIconField ? "size-6" : "max-h-9 max-w-[80%]",
              // The default marks are drawn in near-black.
              !value && dark && "invert",
            )}
          />
          <span
            aria-hidden="true"
            className="absolute bottom-1 right-1 rounded bg-background/90 p-1 text-foreground opacity-70 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Upload className="size-3" />
          </span>
        </UnstyledButton>
        {value && (
          <Tooltip>
            <TooltipTrigger asChild>
              <UnstyledButton
                aria-label={`Reset ${title}`}
                disabled={disabled}
                onClick={() => {
                  onChange(null);
                  setError(null);
                }}
                className="absolute bottom-1 left-1 rounded bg-background/90 p-1 text-foreground opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
              >
                <X className="size-3" />
              </UnstyledButton>
            </TooltipTrigger>
            <TooltipContent>Reset to default</TooltipContent>
          </Tooltip>
        )}
      </div>
      <Input
        ref={input}
        id={`appearance-${field}`}
        type="file"
        className="hidden"
        accept={field === "favicon" ? "image/png" : "image/png,image/svg+xml"}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (
            file.type !== "image/png" &&
            (field === "favicon" || file.type !== "image/svg+xml")
          ) {
            setError(
              field === "favicon"
                ? "Upload a PNG file."
                : "Upload a PNG or SVG file.",
            );
            return;
          }
          if (file.size > 2 * 1024 * 1024) {
            setError("File size must be less than 2 MB.");
            return;
          }
          setError(null);
          const reader = new FileReader();
          reader.onload = () => onChange(String(reader.result));
          reader.readAsDataURL(file);
        }}
      />
      {error && (
        <InlineNotice variant="error">
          <Info />
          <span className="font-medium">{error}</span>
        </InlineNotice>
      )}
    </div>
  );
}

const ASSETS: {
  field: LogoField;
  title: string;
  hint: string;
  dark?: boolean;
}[] = [
  { field: "logo", title: "Logo · Light", hint: "200 × 60 px" },
  { field: "logoDark", title: "Logo · Dark", hint: "200 × 60 px", dark: true },
  { field: "iconLogo", title: "Icon · Light", hint: "28 × 28 px" },
  {
    field: "iconLogoDark",
    title: "Icon · Dark",
    hint: "28 × 28 px",
    dark: true,
  },
  { field: "favicon", title: "Favicon", hint: "32–64 px" },
];
const FEATURED_PALETTES = [
  "caffeine",
  "modern-minimal",
  "claude",
  "mono",
  "nature",
  "tangerine",
  "catppuccin",
  "amber-minimal",
];
const SWATCH_COLORS = [
  "primary",
  "accent",
  "secondary",
  "background",
  "foreground",
];
