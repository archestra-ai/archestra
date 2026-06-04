"use client";

import { Github } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useHasPermissions } from "@/lib/auth/auth.query";

type Integration = {
  href: string;
  title: string;
  description: string;
  icon: ReactNode;
  canView: boolean;
};

export default function IntegrationsSettingsPage() {
  const { data: canViewGithubApps = false } = useHasPermissions({
    githubAppConfig: ["read"],
  });

  const integrations: Integration[] = [
    {
      href: "/settings/integrations/github-apps",
      title: "GitHub Apps",
      description:
        "Store GitHub App credentials once and reuse them across connectors and skill imports.",
      icon: <Github className="h-5 w-5" />,
      canView: canViewGithubApps,
    },
  ].filter((integration) => integration.canView);

  if (integrations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No integrations are available with your current permissions.
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {integrations.map((integration) => (
        <Link key={integration.href} href={integration.href} className="block">
          <Card className="h-full transition-colors hover:border-primary hover:bg-muted/40">
            <CardHeader>
              <div className="flex items-center gap-2">
                {integration.icon}
                <CardTitle>{integration.title}</CardTitle>
              </div>
              <CardDescription>{integration.description}</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}
