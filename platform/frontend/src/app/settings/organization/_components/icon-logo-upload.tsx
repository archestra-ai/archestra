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
import { useUpdateAppearance } from "@/lib/organization.query";

interface IconLogoUploadProps {
  currentIconLogo?: string | null;
  onIconLogoChange?: () => void;
}

export function IconLogoUpload({
  currentIconLogo,
  onIconLogoChange,
}: IconLogoUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(
    currentIconLogo || null,
  );
  const uploadMutation = useUpdateAppearance(
    "Icon logo uploaded successfully",
    "Failed to upload icon logo",
  );
  const removeMutation = useUpdateAppearance(
    "Icon logo removed successfully",
    "Failed to remove icon logo",
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
          const result = await uploadMutation.mutateAsync({ iconLogo: base64 });
          if (!result) throw new Error("Upload failed");
          onIconLogoChange?.();
        } catch {
          setPreview(currentIconLogo || null);
        }
      };
      reader.readAsDataURL(file);
    },
    [currentIconLogo, onIconLogoChange, uploadMutation],
  );

  const handleRemove = useCallback(async () => {
    try {
      const result = await removeMutation.mutateAsync({ iconLogo: null });
      if (!result) throw new Error("Removal failed");
      setPreview(null);
      onIconLogoChange?.();
    } catch {
      // error handled by mutation
    }
  }, [onIconLogoChange, removeMutation]);

  const hasPreview = preview || currentIconLogo;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Icon Logo</CardTitle>
        <CardDescription>
          Upload a square icon for the collapsed sidebar and chat loading
          indicator. PNG only, max 2 MB. Recommended: 28x28px.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="relative h-10 w-10 rounded-md border border-border bg-muted flex items-center justify-center overflow-hidden shrink-0">
            {hasPreview ? (
              <Image
                src={preview || currentIconLogo || ""}
                alt="Icon logo"
                fill
                className="object-contain p-1"
              />
            ) : (
              <span className="text-xs text-muted-foreground">-</span>
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
              {hasPreview ? "Change" : "Upload"}
            </PermissionButton>
            {hasPreview && (
              <PermissionButton
                permissions={{ organizationSettings: ["update"] }}
                variant="outline"
                size="sm"
                onClick={handleRemove}
                disabled={removeMutation.isPending}
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
      </CardContent>
    </Card>
  );
}
