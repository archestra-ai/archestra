export const APPEARANCE_PAGES = [
  {
    id: "branding",
    label: "Branding",
    description: "Name, logos, and colors for your organization.",
    sections: ["brand", "logos", "theme"],
  },
  {
    id: "chat",
    label: "Chat",
    description: "Layout, input prompts, helpful links, and support messages.",
    sections: ["layout", "placeholders", "links", "support"],
  },
  {
    id: "other",
    label: "Other",
    description: "A guided introduction and announcements across the app.",
    sections: ["onboarding", "notification"],
  },
] as const;

export type AppearancePageId = (typeof APPEARANCE_PAGES)[number]["id"];
export type AppearanceSectionId =
  (typeof APPEARANCE_PAGES)[number]["sections"][number];
