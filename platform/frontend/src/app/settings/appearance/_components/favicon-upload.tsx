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
      description="PNG only, max 2 MB. Recommended: 32×32 or 64×64."
      fieldName="favicon"
      currentImage={currentFavicon}
      onImageChange={onFaviconChange}
    />
  );
}
