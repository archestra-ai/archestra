import type { archestraApiTypes } from "@shared";

export type StoredConnectionBaseUrl = NonNullable<
  archestraApiTypes.UpdateConnectionSettingsData["body"]["connectionBaseUrls"]
>[number];

export type BaseUrlMetaRecord = Record<
  string,
  { description: string; isDefault: boolean; visible: boolean }
>;

export function buildBaseUrlMeta(
  stored: StoredConnectionBaseUrl[] | null,
): BaseUrlMetaRecord {
  const out: BaseUrlMetaRecord = {};
  if (!stored) return out;
  for (const item of stored) {
    out[item.url] = {
      description: item.description ?? "",
      isDefault: !!item.isDefault,
      visible: item.visible ?? true,
    };
  }
  return out;
}

export function collapseBaseUrlMeta(
  envUrls: readonly string[],
  meta: BaseUrlMetaRecord,
): StoredConnectionBaseUrl[] | null {
  const items: StoredConnectionBaseUrl[] = [];
  for (const url of envUrls) {
    const m = meta[url];
    if (!m) continue;
    const isDefault = m.visible && m.isDefault;
    const visible = m.visible;
    if (!m.description.trim() && !isDefault && visible) continue;
    items.push({
      url,
      description: m.description.trim(),
      isDefault,
      visible,
    });
  }
  return items.length === 0 ? null : items;
}

/**
 * Resolve the URL the radio should show as selected. If no env URL is marked
 * default in `meta` (e.g. the stored default has been removed from env), fall
 * back to the first env URL — mirroring the /connection page's runtime
 * fallback chain.
 */
export function resolveDefaultBaseUrl(
  envUrls: readonly string[],
  meta: BaseUrlMetaRecord,
): string | null {
  return envUrls.find((url) => meta[url]?.isDefault) ?? envUrls[0] ?? null;
}

/**
 * Produce a fresh meta record where exactly `selected` is marked default. Only
 * env URLs are included — anything previously stored for a URL no longer in
 * env is dropped, so a stale stored default can never lock the admin out of
 * choosing a new one.
 */
export function applyDefaultBaseUrl(
  envUrls: readonly string[],
  prev: BaseUrlMetaRecord,
  selected: string,
): BaseUrlMetaRecord {
  const next: BaseUrlMetaRecord = {};
  for (const candidate of envUrls) {
    const existing = prev[candidate] ?? {
      description: "",
      isDefault: false,
      visible: true,
    };
    next[candidate] = {
      description: existing.description,
      visible: existing.visible,
      isDefault: candidate === selected,
    };
  }
  return next;
}

/**
 * Toggle visibility for one URL. Hiding a URL also clears its default flag —
 * a hidden URL can't be picked by end users, so a hidden default would
 * silently break pre-selection on /connection.
 */
export function applyVisibility(
  prev: BaseUrlMetaRecord,
  url: string,
  visible: boolean,
): BaseUrlMetaRecord {
  const existing = prev[url] ?? {
    description: "",
    isDefault: false,
    visible: true,
  };
  return {
    ...prev,
    [url]: {
      description: existing.description,
      visible,
      isDefault: visible ? existing.isDefault : false,
    },
  };
}
