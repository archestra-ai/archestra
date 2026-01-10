"use client";

import { ShieldCheck } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useOrganization,
  useUpdateOrganization,
} from "@/lib/organization.query";

export default function SecuritySettingsPage() {
  const { data: organization } = useOrganization();
  const updateOrgMutation = useUpdateOrganization(
    "Setting updated",
    "Failed to update setting",
  );

  const handleGlobalToolPolicyChange = async (
    value: "permissive" | "restrictive",
  ) => {
    await updateOrgMutation.mutateAsync({
      globalToolPolicy: value,
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-500" />
            <CardTitle>Agentic Security</CardTitle>
          </div>
          <CardDescription>
            Default behavior for tools without specific policies configured
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Select
              value={organization?.globalToolPolicy ?? "permissive"}
              onValueChange={handleGlobalToolPolicyChange}
              disabled={updateOrgMutation.isPending}
            >
              <SelectTrigger id="global-tool-policy" className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="permissive">Permissive</SelectItem>
                <SelectItem value="restrictive">Restrictive</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground mt-2">
              {organization?.globalToolPolicy === "restrictive"
                ? "Agents are blocked from all actions unless a specific policy explicitly allows them."
                : "Agents can perform any action unless a specific policy explicitly blocks them."}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
