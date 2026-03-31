import { z } from "zod";
import { SUPPORTED_THEMES } from "./themes/theme-config";

export const OrganizationThemeSchema = z.enum(SUPPORTED_THEMES);
export const OrganizationCustomFontSchema = z.enum([
  "lato",
  "inter",
  "open-sans",
  "roboto",
  "source-sans-pro",
  "jetbrains-mono",
]);

export type OrganizationTheme = z.infer<typeof OrganizationThemeSchema>;
export type OrganizationCustomFont = z.infer<
  typeof OrganizationCustomFontSchema
>;
