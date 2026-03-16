"use client";

import { Upload, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Card, CardContent } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { useUpdateAppearanceSettings } from "@/lib/organization.query";

interface ImageUploadProps {
  title: string;
  description: string;
  fieldName: string;
  currentImage?: string | null;
  onImageChange?: () => void;
}

export function ImageUpload({
  title,
  description,
  fieldName,
  currentImage,
  onImageChange,
}: ImageUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentImage || null);
  const { mutateAsync: uploadImage, isPending: isUploadPending } =
    useUpdateAppearanceSettings(
      `${title} uploaded successfully`,
      `Failed to upload ${title.toLowerCase()}`,
    );
  const { mutateAsync: removeImage, isPending: isRemovePending } =
    useUpdateAppearanceSettings(
      `${title} removed successfully`,
      `Failed to remove ${title.toLowerCase()}`,
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
          const result = await uploadImage({
            [fieldName]: base64,
          });
          if (!result) throw new Error("Upload failed");
          onImageChange?.();
        } catch {
          setPreview(currentImage || null);
        }
      };
      reader.readAsDataURL(file);
    },
    [currentImage, onImageChange, uploadImage, fieldName],
  );

  const handleRemove = useCallback(async () => {
    try {
      const result = await removeImage({ [fieldName]: null });
      if (!result) throw new Error("Removal failed");
      setPreview(null);
      onImageChange?.();
    } catch {
      // error handled by mutation
    }
  }, [onImageChange, removeImage, fieldName]);

  const hasPreview = preview || currentImage;

  return (
    <Card>
      <SettingsCardHeader title={title} description={description} />
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="relative h-10 w-10 rounded-md border border-border bg-muted flex items-center justify-center overflow-hidden shrink-0">
            {hasPreview ? (
              <Image
                src={preview || currentImage || ""}
                alt={title}
                fill
                className="object-contain p-1"
              />
            ) : (
              <span className="text-xs text-muted-foreground">–</span>
            )}
          </div>
          <div className="flex gap-2">
            <PermissionButton
              permissions={{ organizationSettings: ["update"] }}
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadPending}
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
                disabled={isRemovePending}
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
