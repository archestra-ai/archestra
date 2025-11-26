"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Pencil, Trash2 } from "lucide-react";
import type { SsoProvider } from "@shared";
import { useUpdateSsoProvider } from "@/lib/sso-provider.query";

interface SsoProviderListProps {
  providers: SsoProvider[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SsoProviderList({
  providers,
  onEdit,
  onDelete,
}: SsoProviderListProps) {
  const updateMutation = useUpdateSsoProvider();

  const handleToggleEnabled = async (provider: SsoProvider) => {
    await updateMutation.mutateAsync({
      id: provider.id,
      data: { enabled: !provider.enabled },
    });
  };

  if (providers.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No SSO Providers</CardTitle>
          <CardDescription>
            Get started by adding your first SSO provider. You can configure
            OIDC or SAML providers to enable single sign-on for your
            organization.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configured Providers</CardTitle>
        <CardDescription>
          Manage your organization&apos;s SSO providers
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((provider) => (
              <TableRow key={provider.id}>
                <TableCell className="font-medium">{provider.name}</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {provider.type.toUpperCase()}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={provider.enabled ? "default" : "secondary"}
                  >
                    {provider.enabled ? "Active" : "Disabled"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={provider.enabled}
                    onCheckedChange={() => handleToggleEnabled(provider)}
                    disabled={updateMutation.isPending}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onEdit(provider.id)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(provider.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
