"use client";

import { ArrowLeft, FileX } from "lucide-react";
import Link from "next/link";
import type { MouseEvent } from "react";
import { LoadingState } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
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
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      asChild
    >
      <Link href={href} onClick={onClick}>
        <ArrowLeft className="h-4 w-4" />
        {label}
      </Link>
    </Button>
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
      <LoadingState label="Loading skill…" variant="page" />
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
