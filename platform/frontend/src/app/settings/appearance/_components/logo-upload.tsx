"use client";

import { Upload, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { useUpdateOrganization } from "@/lib/organization.query";

interface LogoUploadProps {
  currentLogo?: string | null;
  onLogoChange?: () => void;
}

export function LogoUpload({ currentLogo, onLogoChange }: LogoUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentLogo || null);
  const uploadOrganizationLogoMutation = useUpdateOrganization(
    "Logo uploaded successfully",
    "Failed to upload logo",
  );
  const removeOrganizationLogoMutation = useUpdateOrganization(
    "Logo removed successfully",
    "Failed to remove logo",
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      // Validate file type
      if (file.type !== "image/png") {
        toast.error("Please upload a PNG file");
        return;
      }

      // Validate file size (2MB)
      if (file.size > 2 * 1024 * 1024) {
        toast.error("File size must be less than 2MB");
        return;
      }

      // Convert to base64
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        setPreview(base64);

        try {
          const result = await uploadOrganizationLogoMutation.mutateAsync({
            logo: base64,
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
    [currentLogo, onLogoChange, uploadOrganizationLogoMutation],
  );

  const handleRemoveLogo = useCallback(async () => {
    try {
      const result = await removeOrganizationLogoMutation.mutateAsync({
        logo: null,
      });

      if (!result) {
        throw new Error("Removal failed");
      }

      setPreview(null);
      onLogoChange?.();
    } catch (error) {
      console.error("Failed to remove logo:", error);
    }
  }, [onLogoChange, removeOrganizationLogoMutation]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const hasPreviewOrCurrentLogo = preview || currentLogo;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Logo</CardTitle>
        <CardDescription>
          Upload a custom logo for your organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="relative h-16 w-48 rounded-md border border-border bg-muted flex items-center justify-center overflow-hidden">
            {hasPreviewOrCurrentLogo ? (
              <Image
                src={preview || currentLogo || ""}
                alt="Organization logo"
                fill
                className="object-contain p-2"
              />
            ) : (
              <p className="text-sm text-muted-foreground">No logo</p>
            )}
          </div>

          <div className="flex gap-2">
            <PermissionButton
              permissions={{ organization: ["update"] }}
              variant="outline"
              size="sm"
              onClick={handleUploadClick}
              disabled={uploadOrganizationLogoMutation.isPending}
            >
              <Upload className="h-4 w-4 mr-2" />
              {hasPreviewOrCurrentLogo ? "Change" : "Upload"}
            </PermissionButton>

            {hasPreviewOrCurrentLogo && (
              <PermissionButton
                permissions={{ organization: ["update"] }}
                variant="outline"
                size="sm"
                onClick={handleRemoveLogo}
                disabled={removeOrganizationLogoMutation.isPending}
              >
                <X className="h-4 w-4 mr-2" />
                Remove
              </PermissionButton>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png"
          className="hidden"
          onChange={handleFileSelect}
        />

        <p className="text-sm text-muted-foreground">
          Recommended size: 200x60px.
        </p>
      </CardContent>
    </Card>
  );
}
