// Attributes that keep browser and extension password managers away from
// app-secret fields (API keys, tokens, client secrets). The load-bearing part
// is rendering type="text" (done by the components): browsers only attach
// save-password / strong-password UI to password-classified fields. Rendering
// type="password" — or masking via -webkit-text-security — makes iCloud
// Passwords pop its AutoFill prompt over dialogs, and autoComplete="new-password"
// invites Chrome's strong-password generator.
export const SECRET_FIELD_SUPPRESSION_PROPS = {
  autoComplete: "off",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  // 1Password
  "data-1p-ignore": true,
  // LastPass
  "data-lpignore": "true",
  // Bitwarden
  "data-bwignore": "true",
  // Dashlane
  "data-form-type": "other",
} as const;
