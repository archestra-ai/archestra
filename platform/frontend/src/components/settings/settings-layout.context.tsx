"use client";

import { createContext, useContext } from "react";
import type { PageLayout } from "@/components/page-layout";

export type SettingsPageHeader = {
  title: React.ReactNode;
  /** Browser tab title, when `title` is composed markup rather than a string. */
  documentTitle?: string;
  description?: React.ReactNode;
  /** The record's own mark, drawn beside the title as on a detail page. */
  icon?: React.ReactNode;
  backLink?: React.ReactNode;
  status?: React.ReactNode;
  /**
   * Secondary tabs under the header, for a record with more facets than one
   * screen should carry at once. The same bar the agent, MCP gateway and MCP
   * server detail pages use, reached from here because a settings page does
   * not render its own {@link PageLayout} - the settings layout does.
   *
   * Only a record page has any use for it. The section list on the left is
   * how you move between settings pages; these move within one.
   */
  tabs?: React.ComponentProps<typeof PageLayout>["tabs"];
};

type SettingsLayoutContextType = {
  setActionButton: (node: React.ReactNode) => void;
  setPageHeader: (header: SettingsPageHeader | null) => void;
};

export const SettingsLayoutContext = createContext<SettingsLayoutContextType>({
  setActionButton: () => {},
  setPageHeader: () => {},
});

export function useSetSettingsAction() {
  return useContext(SettingsLayoutContext).setActionButton;
}

/**
 * Lets a settings page replace the header the settings layout would otherwise
 * derive from the pathname. A record page needs to say *which* record you are
 * on, and the layout's page config is keyed by route, so without this the
 * detail pages under `/settings/*` inherit their list's title and never name
 * their subject.
 *
 * Call it from an effect and clear it on unmount, the way `setActionButton` is
 * used, so the header does not outlive the page that set it.
 */
export function useSetSettingsPageHeader() {
  return useContext(SettingsLayoutContext).setPageHeader;
}
