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

interface FaviconUploadProps {
  currentFavicon?: string | null;
  onFaviconChange?: () => void;
}

export function FaviconUpload({
  currentFavicon,
  onFaviconChange,
}: FaviconUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(currentFavicon || null);
  const uploadMutation = useUpdateAppearance(
    "Favicon uploaded successfully",
    "Failed to upload favicon",
  );
  const removeMutation = useUpdateAppearance(
    "Favicon removed successfully",
    "Failed to remove favicon",
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
          const result = await uploadMutation.mutateAsync({ favicon: base64 });
          if (!result) throw new Error("Upload failed");
          onFaviconChange?.();
        } catch {
          setPreview(currentFavicon || null);
        }
      };
      reader.readAsDataURL(file);
    },
    [currentFavicon, onFaviconChange, uploadMutation],
  );

  const handleRemove = useCallback(async () => {
    try {
      const result = await removeMutation.mutateAsync({ favicon: null });
      if (!result) throw new Error("Removal failed");
      setPreview(null);
      onFaviconChange?.();
    } catch {
      // error handled by mutation
    }
  }, [onFaviconChange, removeMutation]);

  const hasPreview = preview || currentFavicon;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Favicon</CardTitle>
        <CardDescription>
          Upload a custom favicon for your organization. PNG only, max 2 MB.
          Recommended: 32x32px or 64x64px.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="relative h-10 w-10 rounded-md border border-border bg-muted flex items-center justify-center overflow-hidden shrink-0">
            {hasPreview ? (
              <Image
                src={preview || currentFavicon || ""}
                alt="Favicon"
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
