/**
 * Validates an organization logo provided as a data URL.
 *
 * Checks:
 * 1. Must be a data:image/png;base64 data URL
 * 2. Base64 payload must be valid (decodable)
 * 3. Decoded bytes must start with PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)
 * 4. Decoded size must be at most 2 MB
 */
export function validateLogoDataUrl(logo: string): LogoValidationResult {
  if (!logo.startsWith(DATA_URL_PREFIX)) {
    return {
      valid: false,
      error:
        "Logo must be a PNG image in data URL format (data:image/png;base64,...)",
    };
  }

  const base64Data = logo.slice(DATA_URL_PREFIX.length);

  if (base64Data.length === 0) {
    return { valid: false, error: "Logo base64 data is empty" };
  }

  // Validate base64 encoding: must match the standard base64 alphabet
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
    return { valid: false, error: "Logo contains invalid base64 characters" };
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64Data, "base64");
  } catch {
    return { valid: false, error: "Logo contains invalid base64 data" };
  }

  // A valid PNG must have at least the 8-byte signature
  if (decoded.length < PNG_MAGIC_BYTES.length) {
    return {
      valid: false,
      error: "Logo data is too small to be a valid PNG image",
    };
  }

  // Verify PNG magic bytes
  const hasPngSignature = PNG_MAGIC_BYTES.every(
    (byte, index) => decoded[index] === byte,
  );
  if (!hasPngSignature) {
    return {
      valid: false,
      error:
        "Logo data does not contain a valid PNG image (invalid file signature)",
    };
  }

  // Check decoded file size
  if (decoded.length > MAX_LOGO_BYTES) {
    return {
      valid: false,
      error: `Logo file size exceeds the 2 MB limit (got ${(decoded.length / (1024 * 1024)).toFixed(2)} MB)`,
    };
  }

  return { valid: true };
}

// --- Internal constants & types ---

const DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB
// PNG file signature: https://www.w3.org/TR/png/#5PNG-file-signature
const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type LogoValidationResult =
  | { valid: true }
  | { valid: false; error: string };
