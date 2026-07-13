"use client";

import { Upload, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Card, CardContent } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { useUpdateAppearanceSettings } from "@/lib/organization.query";

const MAX_BYTES = 2 * 1024 * 1024;

type LogoField = "logo" | "logoDark" | "iconLogo" | "iconLogoDark";

interface LogosSectionProps {
  currentLogo?: string | null;
  currentLogoDark?: string | null;
  currentIconLogo?: string | null;
  currentIconLogoDark?: string | null;
  onChange?: () => void;
}

const ROWS: {
  label: string;
  description: string;
  field: LogoField;
}[] = [
  {
    label: "Logo",
    description: "Sidebar header and auth pages · 200×60",
    field: "logo",
  },
  {
    label: "Logo (Dark)",
    description: "Sidebar header and auth pages · 200×60",
    field: "logoDark",
  },
  {
    label: "Icon",
    description: "Collapsed sidebar and chat loading indicator · 28×28",
    field: "iconLogo",
  },
  {
    label: "Icon (Dark)",
    description: "Collapsed sidebar and chat loading indicator · 28×28",
    field: "iconLogoDark",
  },
];

export function LogosSection({
  currentLogo,
  currentLogoDark,
  currentIconLogo,
  currentIconLogoDark,
  onChange,
}: LogosSectionProps) {
  const values: Record<LogoField, string | null | undefined> = {
    logo: currentLogo,
    logoDark: currentLogoDark,
    iconLogo: currentIconLogo,
    iconLogoDark: currentIconLogoDark,
  };

  return (
    <Card>
      <SettingsCardHeader title="Logos" description="PNG or SVG, max 2 MB." />
      <CardContent>
        <div className="divide-y divide-border border-t border-border">
          {ROWS.map(({ label, description, field }) => (
            <LogoRow
              key={field}
              label={label}
              description={description}
              field={field}
              current={values[field]}
              onChange={onChange}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LogoRow({
  label,
  description,
  field,
  current,
  onChange,
}: {
  label: string;
  description: string;
  field: LogoField;
  current?: string | null;
  onChange?: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(current || null);
  const { mutateAsync: upload, isPending: isUploadPending } =
    useUpdateAppearanceSettings("Logo updated", "Failed to update logo");
  const { mutateAsync: remove, isPending: isRemovePending } =
    useUpdateAppearanceSettings("Logo removed", "Failed to remove logo");

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (file.type !== "image/png" && file.type !== "image/svg+xml") {
        toast.error("Please upload a PNG or SVG file");
        return;
      }
      if (file.size > MAX_BYTES) {
        toast.error("File size must be less than 2MB");
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        setPreview(base64);
        try {
          const result = await upload({ [field]: base64 });
          if (!result) throw new Error("Upload failed");
          onChange?.();
        } catch {
          setPreview(current || null);
        }
      };
      reader.readAsDataURL(file);
    },
    [current, field, onChange, upload],
  );

  const handleRemove = useCallback(async () => {
    try {
      const result = await remove({ [field]: null });
      if (!result) throw new Error("Removal failed");
      setPreview(null);
      onChange?.();
    } catch {
      // mutation toast handles UX
    }
  }, [field, onChange, remove]);

  const value = preview || current;
  const isIcon = field === "iconLogo" || field === "iconLogoDark";

  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-14 w-28 shrink-0 rounded border border-border bg-muted flex items-center justify-center overflow-hidden">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt={label}
            className="h-full w-full object-contain p-1"
          />
        ) : isIcon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/logo-icon.svg"
            alt=""
            aria-hidden="true"
            className="h-full w-full object-contain p-1 opacity-60"
          />
        ) : (
          <div
            className="flex items-center gap-1.5 opacity-60"
            aria-hidden="true"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-icon.svg" alt="" className="h-6 w-6" />
            <span className="text-xs font-semibold leading-none">
              Archestra.AI
            </span>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="text-xs text-muted-foreground leading-tight mt-0.5 truncate">
          {description}
        </p>
      </div>
      <div className="flex gap-1">
        <PermissionButton
          permissions={{ organizationSettings: ["update"] }}
          variant="ghost"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploadPending}
          aria-label={value ? `Change ${label}` : `Upload ${label}`}
        >
          <Upload className="h-4 w-4" />
        </PermissionButton>
        {value && (
          <PermissionButton
            permissions={{ organizationSettings: ["update"] }}
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={isRemovePending}
            aria-label={`Remove ${label}`}
          >
            <X className="h-4 w-4" />
          </PermissionButton>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        aria-label="Upload logo image"
        accept="image/png,image/svg+xml"
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>
  );
}
