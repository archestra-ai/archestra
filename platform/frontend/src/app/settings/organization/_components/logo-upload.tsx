"use client";

import { Upload, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Card, CardContent } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { useUpdateAppearanceSettings } from "@/lib/organization.query";

interface LogoUploadProps {
  currentLogo?: string | null;
  currentLogoDark?: string | null;
  onLogoChange?: () => void;
}

export function LogoUpload({
  currentLogo,
  currentLogoDark,
  onLogoChange,
}: LogoUploadProps) {
  return (
    <Card>
      <SettingsCardHeader
        title="Organization Logo"
        description="Upload custom logos for your organization. The dark mode logo is used when dark mode is active and falls back to the default logo if not set."
      />
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <LogoSlot
            label="Default"
            currentLogo={currentLogo}
            field="logo"
            onLogoChange={onLogoChange}
          />
          <LogoSlot
            label="Dark Mode"
            currentLogo={currentLogoDark}
            field="logoDark"
            onLogoChange={onLogoChange}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Recommended size: 200x60px. PNG only, max 2 MB.
        </p>
      </CardContent>
    </Card>
  );
}

function LogoSlot({
  label,
  currentLogo,
  field,
  onLogoChange,
}: {
  label: string;
  currentLogo?: string | null;
  field: "logo" | "logoDark";
  onLogoChange?: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentLogo || null);
  const uploadMutation = useUpdateAppearanceSettings(
    "Logo uploaded successfully",
    "Failed to upload logo",
  );
  const removeMutation = useUpdateAppearanceSettings(
    "Logo removed successfully",
    "Failed to remove logo",
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (file.type !== "image/png") {
        toast.error("Please upload a PNG file");
        return;
      }

      if (file.size > 2 * 1024 * 1024) {
        toast.error("File size must be less than 2MB");
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        setPreview(base64);

        try {
          const result = await uploadMutation.mutateAsync({
            [field]: base64,
          });

          if (!result) {
            throw new Error("Upload failed");
          }

          onLogoChange?.();
        } catch (error) {
          console.error("Failed to upload logo:", error);
          setPreview(currentLogo || null);
        }
      };
      reader.readAsDataURL(file);
    },
    [currentLogo, onLogoChange, uploadMutation, field],
  );

  const handleRemoveLogo = useCallback(async () => {
    try {
      const result = await removeMutation.mutateAsync({
        [field]: null,
      });

      if (!result) {
        throw new Error("Removal failed");
      }

      setPreview(null);
      onLogoChange?.();
    } catch (error) {
      console.error("Failed to remove logo:", error);
    }
  }, [onLogoChange, removeMutation, field]);

  const hasPreviewOrCurrentLogo = preview || currentLogo;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="relative h-16 w-full rounded-md border border-border bg-muted flex items-center justify-center overflow-hidden">
        {hasPreviewOrCurrentLogo ? (
          <Image
            src={preview || currentLogo || ""}
            alt={`${label} logo`}
            fill
            className="object-contain p-2"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No logo</p>
        )}
      </div>
      <div className="flex gap-2">
        <PermissionButton
          permissions={{ organizationSettings: ["update"] }}
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          <Upload className="h-4 w-4 mr-2" />
          {hasPreviewOrCurrentLogo ? "Change" : "Upload"}
        </PermissionButton>

        {hasPreviewOrCurrentLogo && (
          <PermissionButton
            permissions={{ organizationSettings: ["update"] }}
            variant="outline"
            size="sm"
            onClick={handleRemoveLogo}
            disabled={removeMutation.isPending}
          >
            <X className="h-4 w-4 mr-2" />
            Remove
          </PermissionButton>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png"
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>
  );
}
