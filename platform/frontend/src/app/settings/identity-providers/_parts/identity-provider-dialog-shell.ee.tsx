"use client";

import {
  getIdentityProviderDialogNavButtonTestId,
  type IdentityProviderFormValues,
} from "@archestra/shared";
import { AlertCircle, IdCard } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { SubmitHandler, UseFormReturn } from "react-hook-form";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Form } from "@/components/ui/form";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { getIdentityProviderFormIssue } from "./identity-provider-form-validation.ee";

export type IdentityProviderDialogSection =
  | "general"
  | "service-provider-metadata"
  | "attribute-mapping"
  | "enterprise-managed-credentials"
  | "role-mapping"
  | "team-sync"
  | "token-debugger";

export interface IdentityProviderDialogNavItem {
  id: IdentityProviderDialogSection;
  label: string;
}

interface IdentityProviderDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  providerLabel: string;
  form: UseFormReturn<IdentityProviderFormValues>;
  activeSection: IdentityProviderDialogSection;
  navItems: IdentityProviderDialogNavItem[];
  onActiveSectionChange: (section: IdentityProviderDialogSection) => void;
  onSubmit: SubmitHandler<IdentityProviderFormValues>;
  children: ReactNode;
  footer: ReactNode;
  sidebarFooter?: ReactNode;
}

export function IdentityProviderDialogShell({
  open,
  onOpenChange,
  title,
  description,
  providerLabel,
  form,
  activeSection,
  navItems,
  onActiveSectionChange,
  onSubmit,
  children,
  footer,
  sidebarFooter,
}: IdentityProviderDialogShellProps) {
  const [issue, setIssue] =
    useState<ReturnType<typeof getIdentityProviderFormIssue>>(null);
  useEffect(() => {
    if (!open) setIssue(null);
  }, [open]);
  useEffect(() => {
    if (issue?.section === activeSection)
      form.setFocus(issue.path, { shouldSelect: true });
  }, [issue, activeSection, form]);
  const handleSubmit = form.handleSubmit(
    (data, event) => {
      setIssue(null);
      return onSubmit(data, event);
    },
    (errors) => {
      const nextIssue = getIdentityProviderFormIssue(errors);
      if (!nextIssue) return;
      const section = navItems.some((item) => item.id === nextIssue.section)
        ? nextIssue.section
        : "general";
      setIssue({ ...nextIssue, section });
      onActiveSectionChange(section);
    },
  );
  const issueSection =
    navItems.find((item) => item.id === issue?.section)?.label ??
    "provider settings";
  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      sidebarLabel={providerLabel}
      sidebarDescription="Identity Provider"
      sidebarIcon={<IdCard className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={navItems}
      onActiveSectionChange={onActiveSectionChange}
      onSubmit={handleSubmit}
      footer={footer}
      sidebarFooter={sidebarFooter}
      getNavItemTestId={getIdentityProviderDialogNavButtonTestId}
      wrapForm={(formContent) => <Form {...form}>{formContent}</Form>}
    >
      {issue && (
        <InlineNotice variant="error" role="alert" className="mb-4">
          <AlertCircle />
          <span className="font-medium">Could not save provider.</span>
          <InlineNoticeText>
            Fix the error in {issueSection}: {issue.message}
          </InlineNoticeText>
        </InlineNotice>
      )}
      {children}
    </TabbedDialogShell>
  );
}
