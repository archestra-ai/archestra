"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { archestraApiTypes } from "@shared";
import {
  Building2,
  Globe,
  Lock,
  Mail,
  ShieldCheck,
  UserRoundCog,
} from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useUpdateProfile } from "@/lib/agent.query";
import { useAgentEmailAddress } from "@/lib/chatops/incoming-email.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  AgentEmailSettingsFormSchema,
  type AgentEmailSettingsFormValues,
  describeIncomingEmailSecurityMode,
} from "./email-trigger.utils";

type AgentRecord = archestraApiTypes.GetAllAgentsResponses["200"][number];

interface AgentEmailSettingsDialogProps {
  agent: AgentRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerEnabled: boolean;
}

export function AgentEmailSettingsDialog({
  agent,
  open,
  onOpenChange,
  providerEnabled,
}: AgentEmailSettingsDialogProps) {
  const appName = useAppName();
  const updateAgentMutation = useUpdateProfile();
  const form = useForm<AgentEmailSettingsFormValues>({
    resolver: zodResolver(AgentEmailSettingsFormSchema),
    defaultValues: {
      incomingEmailEnabled: false,
      incomingEmailSecurityMode: "private",
      incomingEmailAllowedDomain: "",
    },
  });

  const incomingEmailEnabled = form.watch("incomingEmailEnabled");
  const incomingEmailSecurityMode = form.watch("incomingEmailSecurityMode");

  useEffect(() => {
    if (!agent || !open) return;

    form.reset({
      incomingEmailEnabled: agent.incomingEmailEnabled,
      incomingEmailSecurityMode: agent.incomingEmailSecurityMode,
      incomingEmailAllowedDomain: agent.incomingEmailAllowedDomain ?? "",
    });
  }, [agent, open, form.reset]);

  const { data: emailAddress } = useAgentEmailAddress(
    providerEnabled && open && incomingEmailEnabled && agent ? agent.id : null,
  );

  const handleSubmit = async (values: AgentEmailSettingsFormValues) => {
    if (!agent) return;

    const result = await updateAgentMutation.mutateAsync({
      id: agent.id,
      data: {
        incomingEmailEnabled: values.incomingEmailEnabled,
        incomingEmailSecurityMode: values.incomingEmailSecurityMode,
        incomingEmailAllowedDomain:
          values.incomingEmailEnabled &&
          values.incomingEmailSecurityMode === "internal"
            ? values.incomingEmailAllowedDomain.trim()
            : null,
      },
    });

    if (result?.id) {
      onOpenChange(false);
    }
  };

  const title = agent
    ? agent.incomingEmailEnabled
      ? `Edit email settings for ${agent.name}`
      : `Enable email for ${agent.name}`
    : "Edit email settings";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Configure how this agent can be invoked by email.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <DialogForm onSubmit={form.handleSubmit(handleSubmit)}>
            <DialogBody className="space-y-6">
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Mail className="h-4 w-4" />
                      Enable email invocation
                    </div>
                    <p className="text-sm text-muted-foreground">
                      When enabled, this agent can be triggered from its unique
                      email alias.
                    </p>
                  </div>
                  <FormField
                    control={form.control}
                    name="incomingEmailEnabled"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {incomingEmailEnabled && (
                <>
                  <FormField
                    control={form.control}
                    name="incomingEmailSecurityMode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Security mode</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Choose how email access is restricted" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="private">
                              <div className="flex items-center gap-2">
                                <Lock className="h-4 w-4" />
                                Private
                              </div>
                            </SelectItem>
                            <SelectItem value="internal">
                              <div className="flex items-center gap-2">
                                <Building2 className="h-4 w-4" />
                                Internal
                              </div>
                            </SelectItem>
                            <SelectItem value="public">
                              <div className="flex items-center gap-2">
                                <Globe className="h-4 w-4" />
                                Public
                              </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormDescription>
                          {describeIncomingEmailSecurityMode(
                            incomingEmailSecurityMode,
                            form.watch("incomingEmailAllowedDomain"),
                            appName,
                          )}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {incomingEmailSecurityMode === "internal" && (
                    <FormField
                      control={form.control}
                      name="incomingEmailAllowedDomain"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Allowed domain</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="company.com"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormDescription>
                            Only senders from this exact domain can invoke the
                            agent.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </>
              )}

              <div className="rounded-lg border bg-background p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck className="h-4 w-4" />
                  Agent email alias
                </div>
                {providerEnabled ? (
                  incomingEmailEnabled ? (
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-3">
                      <code className="min-w-0 flex-1 break-all text-sm">
                        {emailAddress?.emailAddress ??
                          "Save to generate the email address"}
                      </code>
                      {emailAddress?.emailAddress && (
                        <CopyButton text={emailAddress.emailAddress} />
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Enable email invocation to generate an address for this
                      agent.
                    </p>
                  )
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Configure the incoming email provider first to generate
                    agent aliases.
                  </p>
                )}
              </div>

              <div className="rounded-lg border bg-muted/20 p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <UserRoundCog className="h-4 w-4" />
                  What happens when someone emails this agent
                </div>
                <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <li>The email body becomes the agent's first message.</li>
                  <li>The alias routes the request to this specific agent.</li>
                  <li>Replies continue the same conversation thread.</li>
                </ul>
              </div>
            </DialogBody>

            <div className="flex flex-col-reverse gap-2 border-t px-4 py-3 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <PermissionButton
                type="submit"
                permissions={{ agent: ["update"] }}
                disabled={updateAgentMutation.isPending}
              >
                {updateAgentMutation.isPending ? "Saving..." : "Save settings"}
              </PermissionButton>
            </div>
          </DialogForm>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
