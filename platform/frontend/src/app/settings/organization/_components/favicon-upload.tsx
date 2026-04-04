import { ImageUpload } from "./image-upload";

interface FaviconUploadProps {
  currentFavicon?: string | null;
  onFaviconChange?: () => void;
}

export function FaviconUpload({
  currentFavicon,
  onFaviconChange,
}: FaviconUploadProps) {
  return (
    <ImageUpload
      title="Favicon"
      description="Upload a custom favicon for your organization. PNG only, max 2 MB. Recommended: 32x32px or 64x64px."
      fieldName="favicon"
      currentImage={currentFavicon}
      onImageChange={onFaviconChange}
    />
  );
}
