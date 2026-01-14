"use client";

import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import { PredefinedRoles } from "@/components/roles/predefined-roles";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useRoles } from "@/lib/role.query";

export function RolesList() {
  const { data: roles, isLoading } = useRoles();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>Loading roles...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const predefinedRoles = roles?.filter((role) => role.predefined) || [];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Roles & Permissions</CardTitle>
          <CardDescription className="pt-2">
            View roles and their permissions.
            <br />
            See documentation{" "}
            <a
              href="https://archestra.ai/docs/platform-access-control"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline inline-flex items-center gap-1 block"
            >
              here
            </a>{" "}
            for more information.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <PredefinedRoles predefinedRoles={predefinedRoles} />
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
            Custom Roles
          </h3>
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
            <EnterpriseLicenseRequired featureName="Custom Roles" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
