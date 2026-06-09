"use client";

import {
  getIdentityProviderDialogNavButtonTestId,
  type IdentityProviderFormValues,
} from "@archestra/shared";
import { IdCard } from "lucide-react";
import type { ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Form } from "@/components/ui/form";

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
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
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
      onSubmit={onSubmit}
      footer={footer}
      sidebarFooter={sidebarFooter}
      getNavItemTestId={getIdentityProviderDialogNavButtonTestId}
      wrapForm={(formContent) => <Form {...form}>{formContent}</Form>}
    >
      {children}
    </TabbedDialogShell>
  );
}
