import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';

import { Button } from '@ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ui/components/ui/dialog';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Textarea } from '@ui/components/ui/textarea';
import { useMcpServersStore } from '@ui/stores';

interface AddCustomServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * NOTE: this is the exact same schema as McpServerConfigSchema from @anthropic-ai/dxt
 * (https://github.com/anthropics/dxt/blob/main/src/schemas.ts#L3C14-L7)
 *
 * We could just use zod.extend, BUT for some reason this👇 just doesn't work (typescript complains)
 *
 * const FormSchema = z.object({
 *   name: z.string().min(1, 'Name is required'), <-- Type 'ZodString' is missing the following properties from type 'ZodType
 *   command: z.string().min(1, 'Command is required'),
 *   args: z.string(),
 *   env: z.string(),
 * });
 *
 * See also:
 * https://github.com/archestra-ai/website/blob/fd34cd6400031011a94562785691547fbf152059/app/src/schemas.ts#L106
 */
const FormSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    /**
     * NOTE: they're certain naming restrictions/conventions that we should follow here
     * (this is because the name specified here ends up getting used as (part of) the MCP server's container name)
     *
     * See:
     * https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#dns-subdomain-names
     */
    .regex(/^[A-Za-z0-9-\s]{1,63}$/, 'Name can only contain letters, numbers, spaces, and dashes (-)'),
  command: z.string().min(1, 'Command is required'),
  args: z.string(),
  env: z.string(),
});

type FormData = z.infer<typeof FormSchema>;

const defaultFormData: FormData = {
  name: '',
  command: '',
  args: '',
  env: '',
};

export default function AddCustomServerDialog({ open, onOpenChange }: AddCustomServerDialogProps) {
  const [formData, setFormData] = useState<FormData>(defaultFormData);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  const { installMcpServer, installingMcpServerId, errorInstallingMcpServer } = useMcpServersStore();

  const isSubmitting = installingMcpServerId !== null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Clear previous errors
    setFormErrors({});

    // Validate form data
    const result = FormSchema.safeParse(formData);

    if (!result.success) {
      // Extract field-specific errors
      const errors: Partial<Record<keyof FormData, string>> = {};
      result.error.issues.forEach((issue) => {
        if (issue.path.length > 0) {
          const field = issue.path[0] as keyof FormData;
          if (!errors[field]) {
            errors[field] = issue.message;
          }
        }
      });
      setFormErrors(errors);
      return;
    }

    const validated = result.data;

    // Parse args and env
    const args = validated.args
      .split('\n')
      .map((arg) => arg.trim())
      .filter((arg) => arg.length > 0);

    const envPairs = validated.env
      .split('\n')
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        const [key, value] = pair.split('=');
        return { key: key?.trim(), value: value?.trim() };
      });

    // Validate env pairs
    const invalidEnvPairs = envPairs.filter(({ key, value }) => !key || !value);
    if (invalidEnvPairs.length > 0) {
      setFormErrors({ env: 'Invalid format. Each line must be KEY=value' });
      return;
    }

    try {
      await installMcpServer(false, {
        displayName: validated.name,
        serverConfig: {
          command: validated.command,
          args,
          env: Object.fromEntries(envPairs.map(({ key, value }) => [key, value])),
        },
        userConfigValues: {},
        oauthProvider: null,
      });

      onOpenChange(false);
      setFormData(defaultFormData);
      setFormErrors({});
    } catch (error) {
      // Error is already set in the store by installMcpServer, so we just need to prevent crash
      console.error('Failed to install MCP server:', error);
    }
  };

  const handleInputChange =
    (field: keyof typeof formData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({
        ...prev,
        [field]: e.target.value,
      }));
      // Clear error for this field when user starts typing
      if (formErrors[field]) {
        setFormErrors((prev) => ({
          ...prev,
          [field]: undefined,
        }));
      }
    };

  return (
    <Dialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen) {
          // Clear form data and errors when closing
          setFormData(defaultFormData);
          setFormErrors({});
        }
        onOpenChange(newOpen);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Install Custom MCP Server
          </DialogTitle>
          <DialogDescription>
            Configure a custom MCP server by providing the command and configuration details.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="My Cool Custom MCP Server"
              value={formData.name}
              onChange={handleInputChange('name')}
              disabled={isSubmitting}
              className={formErrors.name ? 'border-destructive' : ''}
            />
            {formErrors.name ? (
              <p className="text-xs text-destructive">{formErrors.name}</p>
            ) : (
              <p className="text-xs text-muted-foreground">A unique name to identify this server</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="command">Command</Label>
            <Input
              id="command"
              placeholder="node"
              value={formData.command}
              onChange={handleInputChange('command')}
              disabled={isSubmitting}
              className={formErrors.command ? 'border-destructive' : ''}
            />
            {formErrors.command ? (
              <p className="text-xs text-destructive">{formErrors.command}</p>
            ) : (
              <p className="text-xs text-muted-foreground">The executable command to run</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="args">Arguments (one per line)</Label>
            <Textarea
              id="args"
              placeholder="/path/to/server.js&#10;--verbose"
              value={formData.args}
              onChange={handleInputChange('args')}
              disabled={isSubmitting}
              rows={3}
              className={formErrors.args ? 'border-destructive' : ''}
            />
            {formErrors.args ? (
              <p className="text-xs text-destructive">{formErrors.args}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Command line arguments, one per line</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="env">Environment Variables (KEY=value format)</Label>
            <Textarea
              id="env"
              placeholder="API_KEY=your-key&#10;PORT=3000"
              value={formData.env}
              onChange={handleInputChange('env')}
              disabled={isSubmitting}
              rows={3}
              className={formErrors.env ? 'border-destructive' : ''}
            />
            {formErrors.env ? (
              <p className="text-xs text-destructive">{formErrors.env}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Environment variables in KEY=value format, one per line</p>
            )}
          </div>

          {errorInstallingMcpServer && <div className="text-sm text-destructive">{errorInstallingMcpServer}</div>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setFormData(defaultFormData);
                setFormErrors({});
                onOpenChange(false);
              }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Installing...
                </>
              ) : (
                'Install Server'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
