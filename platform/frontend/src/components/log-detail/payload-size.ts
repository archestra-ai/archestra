/**
 * Byte sizes of a logged payload's parts, as they weigh in compact JSON, so
 * the tree can say which part made a request large.
 *
 * Sizes are cached per object, so asking for the root once sizes every
 * branch below it in one pass, and the badges on expanded branches are then
 * lookups.
 */
const sizes = new WeakMap<object, number>();

export function jsonByteSize(value: unknown): number {
  if (value === null || typeof value !== "object") {
    // `undefined` and functions only survive JSON inside arrays, as `null`.
    const json = JSON.stringify(value);
    return json === undefined ? 4 : utf8Length(json);
  }
  const cached = sizes.get(value);
  if (cached !== undefined) return cached;

  let size = 2;
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      size += jsonByteSize(item);
      count += 1;
    }
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function") continue;
      size += utf8Length(JSON.stringify(key)) + 1 + jsonByteSize(item);
      count += 1;
    }
  }
  size += Math.max(0, count - 1);
  sizes.set(value, size);
  return size;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 length without allocating an encoded copy of a large string. */
function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    // Each half of a surrogate pair counts 2, so the pair counts 4.
    else if (code >= 0xd800 && code <= 0xdfff) length += 2;
    else length += 3;
  }
  return length;
}
