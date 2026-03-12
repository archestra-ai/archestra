import { ImageUpload } from "./image-upload";

interface IconLogoUploadProps {
  currentIconLogo?: string | null;
  onIconLogoChange?: () => void;
}

export function IconLogoUpload({
  currentIconLogo,
  onIconLogoChange,
}: IconLogoUploadProps) {
  return (
    <ImageUpload
      title="Icon Logo"
      description="Upload a square icon for the collapsed sidebar and chat loading indicator. PNG only, max 2 MB. Recommended: 28x28px."
      fieldName="iconLogo"
      currentImage={currentIconLogo}
      onImageChange={onIconLogoChange}
    />
  );
}
