"use client";

import { FileX } from "lucide-react";
import type { MouseEvent } from "react";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** The page header's way back: to the list, or from the wizard to the skill. */
export function SkillBackLink({
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

/** The skill's page while the skill loads, in the page's own column. */
export function SkillPageLoading() {
  return (
    <PageLayout
      title="Skill"
      description=""
      backLink={<SkillBackLink href="/skills" label="Skills" />}
      maxWidth="wizard"
    >
      {null}
    </PageLayout>
  );
}

/** A skill that is gone or out of reach, for the page and the wizard alike. */
export function SkillNotFound() {
  return (
    <PageLayout
      title="Skill"
      description=""
      backLink={<SkillBackLink href="/skills" label="Skills" />}
      maxWidth="wizard"
    >
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileX />
          </EmptyMedia>
          <EmptyTitle>Skill not found</EmptyTitle>
          <EmptyDescription>
            This skill may have been deleted, or you may not have access to it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </PageLayout>
  );
}

/**
 * A skill whose request failed, which is not a skill that does not exist: the
 * reader gets the reason (a lost connection, a refusal) and a retry, with the
 * same way back to the list.
 */
export function SkillLoadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <PageLayout
      title="Skill"
      description=""
      backLink={<SkillBackLink href="/skills" label="Skills" />}
      maxWidth="wizard"
    >
      <QueryLoadError
        title="Couldn't load this skill"
        error={error}
        onRetry={onRetry}
        className="border"
      />
    </PageLayout>
  );
}
