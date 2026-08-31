"use client";

import { FileX } from "lucide-react";
import type { MouseEvent } from "react";
import { LoadingState } from "@/components/loading";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** The page header's way back: to the list, or from the wizard to the plugin. */
export function PluginBackLink({
  href,
  label,
  onClick,
}: {
  href: string;
  label: string;
  /** Lets a page with unsaved edits ask first (call `preventDefault`). */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <PageBackLink href={href} onClick={onClick}>
      {label}
    </PageBackLink>
  );
}

/** The plugin's page while the plugin loads, in the page's own column. */
export function PluginPageLoading() {
  return (
    <PageLayout
      title="Plugin"
      description=""
      backLink={<PluginBackLink href="/plugins" label="Plugins" />}
      maxWidth="wizard"
    >
      <LoadingState label="Loading plugin…" variant="page" />
    </PageLayout>
  );
}

/** A plugin that is gone or out of reach, for the page and the wizard alike. */
export function PluginNotFound() {
  return (
    <PageLayout
      title="Plugin"
      description=""
      backLink={<PluginBackLink href="/plugins" label="Plugins" />}
      maxWidth="wizard"
    >
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileX />
          </EmptyMedia>
          <EmptyTitle>Plugin not found</EmptyTitle>
          <EmptyDescription>
            This plugin may have been deleted, or you may not have access to it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PageLayout>
  );
}
