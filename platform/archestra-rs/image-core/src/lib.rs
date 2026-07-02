//! Pure, Node-free image shrinking. Decodes an untrusted image under strict
//! resource limits (so a decompression bomb returns `None` instead of aborting
//! the process), then resizes and re-encodes it to fit both a pixel-dimension
//! cap and a byte budget. Lossless PNG is preferred (chat attachments are often
//! text-heavy screenshots); JPEG and progressive downscaling are the fallbacks.
//!
//! This crate is free of Node/NAPI assumptions so the same logic backs both the
//! TypeScript backend (via the `image_core` NAPI adapter) and any future Rust
//! companion that links it directly.

use std::io::Cursor;

use image::{DynamicImage, ImageReader, Limits};

/// Caps the shrunk output must satisfy: a hard byte budget (the model's inline
/// image limit) and a longest-edge pixel cap.
pub struct ShrinkTargets {
    pub max_bytes: usize,
    pub max_dimension: u32,
}

/// A successfully shrunk image. `bytes` is guaranteed `<= targets.max_bytes`.
/// `content_type` is `"image/png"` or `"image/jpeg"`.
pub struct ShrunkImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// Bound decode allocation to ~128 MB — enough for a legitimate ~10 MP photo or
/// any screenshot, far below what a gigapixel bomb would demand. Kept modest
/// because callers run this concurrently (napi AsyncTask, libuv threadpool), so
/// worst-case decode memory is a small multiple of this.
const MAX_DECODE_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
/// Reject either dimension above ~20000 px. A 20000x20000 image is already a
/// bomb; real photos and screenshots stay well under this.
const MAX_DECODE_DIMENSION: u32 = 20_000;
/// JPEG quality for the lossy fallback: high enough to keep text legible.
const JPEG_QUALITY: u8 = 80;
/// Never scale the longest edge below this — past here the image is useless.
const MIN_DIMENSION_FLOOR: u32 = 320;
/// Per-step downscale factor when neither encoding fits the byte budget.
const DOWNSCALE_NUMERATOR: u32 = 3;
const DOWNSCALE_DENOMINATOR: u32 = 4;

/// Shrink `input` to satisfy `targets`, or return `None` if it cannot be decoded
/// or made to fit. Never panics; treats all input as untrusted.
pub fn shrink_image_to_fit(input: &[u8], targets: ShrinkTargets) -> Option<ShrunkImage> {
    if targets.max_bytes == 0 || targets.max_dimension == 0 {
        return None;
    }

    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    limits.max_image_width = Some(MAX_DECODE_DIMENSION);
    limits.max_image_height = Some(MAX_DECODE_DIMENSION);

    let decoded = decode_within_limits(input, limits)?;
    let mut current = fit_within_dimension(decoded, targets.max_dimension);

    loop {
        if let Some(png) = encode_png(&current)
            && png.len() <= targets.max_bytes
        {
            return Some(ShrunkImage {
                bytes: png,
                content_type: "image/png".to_string(),
            });
        }

        if let Some(jpeg) = encode_jpeg(&current)
            && jpeg.len() <= targets.max_bytes
        {
            return Some(ShrunkImage {
                bytes: jpeg,
                content_type: "image/jpeg".to_string(),
            });
        }

        let longest = current.width().max(current.height());
        if longest <= MIN_DIMENSION_FLOOR {
            return None;
        }
        let next = (longest * DOWNSCALE_NUMERATOR / DOWNSCALE_DENOMINATOR).max(MIN_DIMENSION_FLOOR);
        current = fit_within_dimension(current, next);
    }
}

/// Decode `input` under `limits`. Returns `None` (never panics) when the bytes
/// are not a supported image or when decoding would exceed the limits — this is
/// the decompression-bomb guard. `ImageReader` with `Limits` is mandatory here;
/// `image::load_from_memory` has no bound and would OOM-abort the host.
fn decode_within_limits(input: &[u8], limits: Limits) -> Option<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .ok()?;
    reader.limits(limits);
    // NOTE: EXIF orientation is not applied. The primary case (screenshots) has
    // no EXIF orientation, and applying it via ImageReader would mean threading
    // the decoder out before decode, which the 0.25 API makes awkward.
    reader.decode().ok()
}

/// Downscale so the longest edge is at most `max_dimension`, preserving aspect
/// ratio. Smaller images pass through untouched (never upscales).
fn fit_within_dimension(image: DynamicImage, max_dimension: u32) -> DynamicImage {
    if image.width() <= max_dimension && image.height() <= max_dimension {
        return image;
    }
    image.resize(
        max_dimension,
        max_dimension,
        image::imageops::FilterType::Lanczos3,
    )
}

fn encode_png(image: &DynamicImage) -> Option<Vec<u8>> {
    let mut buffer = Cursor::new(Vec::new());
    image.write_to(&mut buffer, image::ImageFormat::Png).ok()?;
    Some(buffer.into_inner())
}

fn encode_jpeg(image: &DynamicImage) -> Option<Vec<u8>> {
    // JPEG has no alpha channel; flatten to RGB so encoding is well-defined.
    let rgb = image.to_rgb8();
    let mut buffer = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, JPEG_QUALITY);
    encoder.encode_image(&DynamicImage::ImageRgb8(rgb)).ok()?;
    Some(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};

    fn gradient_png(width: u32, height: u32) -> Vec<u8> {
        let mut image = RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]);
        }
        let mut buffer = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut buffer, ImageFormat::Png)
            .expect("encoding a fresh gradient PNG cannot fail");
        buffer.into_inner()
    }

    #[test]
    fn shrinks_large_gradient_under_budget() {
        let input = gradient_png(3000, 2000);
        let max_bytes = 200_000;
        let max_dimension = 2576;

        let result = shrink_image_to_fit(
            &input,
            ShrinkTargets {
                max_bytes,
                max_dimension,
            },
        )
        .expect("a shrinkable gradient should produce output");

        assert!(result.bytes.len() <= max_bytes);
        assert!(matches!(
            result.content_type.as_str(),
            "image/png" | "image/jpeg"
        ));

        let decoded =
            image::load_from_memory(&result.bytes).expect("result bytes should decode as an image");
        assert!(decoded.width() <= max_dimension);
        assert!(decoded.height() <= max_dimension);
    }

    #[test]
    fn rejects_garbage_and_empty_bytes() {
        let targets = ShrinkTargets {
            max_bytes: 100_000,
            max_dimension: 1024,
        };
        assert!(shrink_image_to_fit(b"", ShrinkTargets { ..targets }).is_none());
        assert!(shrink_image_to_fit(b"not an image at all", targets).is_none());
    }

    #[test]
    fn decode_guard_returns_none_over_dimension_limit() {
        // A perfectly valid 64x64 PNG, decoded under a deliberately tiny width
        // limit: the bomb guard must return None, not panic or abort.
        let input = gradient_png(64, 64);
        let mut limits = Limits::default();
        limits.max_image_width = Some(10);
        limits.max_image_height = Some(10);

        assert!(decode_within_limits(&input, limits).is_none());
    }

    #[test]
    fn preserves_when_already_small() {
        let input = gradient_png(64, 64);
        let result = shrink_image_to_fit(
            &input,
            ShrinkTargets {
                max_bytes: 10_000_000,
                max_dimension: 1024,
            },
        )
        .expect("a tiny image trivially fits");
        assert!(result.bytes.len() <= 10_000_000);
    }
}
