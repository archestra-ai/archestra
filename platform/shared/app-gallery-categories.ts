/**
 * Canonical Apps Hackathon gallery categories, offered by the upload
 * dropdown and biased toward by the AI-drafted category.
 *
 * Mirrored in the apps-gallery repo's `categories.json` (documentation for
 * submitters, not an enforced list there either). A submission may also
 * carry a short free-text "Other" category the builder typed when none of
 * these fit — the bundle schema accepts any non-empty string, so this list
 * is the suggested/known set, not an enforced enum.
 */
export const APP_GALLERY_CATEGORIES = [
  "Games & Experiments",
  "Workflows",
  "Data & Dashboards",
  "Productivity",
  "Creative & Design",
  "Developer Tools",
] as const;
