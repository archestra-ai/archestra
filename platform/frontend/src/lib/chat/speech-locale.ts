/**
 * Locale handling for the chat composer's microphone.
 *
 * The Web Speech API wants to know what language it is listening to, as a
 * BCP-47 tag (`en-US`). It should not be hardcoded — a German speaker
 * dictating into a recognizer pinned to `en-US` gets phonetic nonsense back.
 */

/**
 * The BCP-47 tag to hand the Web Speech API, derived from the browser's
 * language preferences.
 *
 * Speech recognizers are region-sensitive (`en-US` vs `en-GB` vs `en-IN` are
 * different acoustic models), so a language-only preference like `de` is
 * expanded to its likely region via `Intl.Locale#maximize` — `de` becomes
 * `de-DE`. Returns `undefined` when the browser exposes nothing usable, in
 * which case the caller must leave `lang` alone: the Web Speech API then falls
 * back to the document/user-agent language, which is a better guess than any
 * constant we could pick.
 */
export function resolveSpeechRecognitionLocale(
  preferences: readonly string[] | undefined,
): string | undefined {
  const preferred = preferences?.find(
    (tag) => typeof tag === "string" && tag.trim().length > 0,
  );
  if (!preferred) return undefined;

  const tag = preferred.trim();
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(tag);
  } catch {
    // A malformed `navigator.language` is not worth guessing at.
    return undefined;
  }

  if (locale.region) return `${locale.language}-${locale.region}`;

  try {
    const maximized = locale.maximize();
    if (maximized.region) return `${maximized.language}-${maximized.region}`;
  } catch {
    // maximize() needs CLDR likely-subtags data; without it the bare language
    // tag is still valid input for the recognizer.
  }
  return locale.language;
}

/**
 * The browser's ordered language preferences. `navigator.languages` is the
 * full list the user configured; `navigator.language` is the single top
 * choice and the only one older engines expose.
 */
export function browserLanguagePreferences(): string[] {
  if (typeof navigator === "undefined") return [];
  const languages = navigator.languages;
  if (Array.isArray(languages) && languages.length > 0) return [...languages];
  return navigator.language ? [navigator.language] : [];
}
