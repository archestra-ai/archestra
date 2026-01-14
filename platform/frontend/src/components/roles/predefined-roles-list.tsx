"use client";

import { Shield } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useRoles } from "@/lib/role.query";

export function PredefinedRolesList() {
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
        <div>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
            Predefined Roles
          </h3>
          <div className="space-y-3">
            {predefinedRoles.map((role) => (
              <div
                key={role.id}
                className="flex items-center justify-between rounded-lg border bg-muted/30 p-4"
              >
                <div className="flex items-center gap-3">
                  <Shield className="h-5 w-5 text-primary" />
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold capitalize">{role.name}</h4>
                      <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                        System
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
