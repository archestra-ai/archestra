import { Eye, EyeOff, File, Folder, Info } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Alert, AlertDescription } from '@ui/components/ui/alert';
import { Badge } from '@ui/components/ui/badge';
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
import { Switch } from '@ui/components/ui/switch';
import { ArchestraMcpServerManifest } from '@ui/lib/clients/archestra/catalog/gen';
import { type McpServerUserConfigValues } from '@ui/types';

interface McpServerInstallDialogProps {
  mcpServer: ArchestraMcpServerManifest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (config: McpServerUserConfigValues) => void;
}

export default function McpServerInstallDialog({
  mcpServer,
  open,
  onOpenChange,
  onInstall,
}: McpServerInstallDialogProps) {
  const [configValues, setConfigValues] = useState<McpServerUserConfigValues>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Reset state when dialog opens/closes or server changes
  useEffect(() => {
    if (open && mcpServer?.user_config) {
      // Initialize with default values
      const defaults: McpServerUserConfigValues = {};
      Object.entries(mcpServer.user_config).forEach(([key, field]) => {
        if (field.default !== undefined) {
          defaults[key] = field.default;
        }
      });
      setConfigValues(defaults);
      setShowSecrets({});
      setErrors({});
    }
  }, [open, mcpServer]);

  if (!mcpServer) {
    return null;
  }

  const userConfig = mcpServer.user_config || {};
  const hasUserConfig = Object.keys(userConfig).length > 0;
  const hasOAuth = mcpServer.archestra_config?.oauth?.required || false;

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleConfigChange = (key: string, value: any) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));

    // Clear error for this field
    if (errors[key]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[key];
        return newErrors;
      });
    }
  };

  const validateConfig = (): boolean => {
    const newErrors: Record<string, string> = {};

    Object.entries(userConfig).forEach(([key, field]) => {
      const value = configValues?.[key];

      // Check required fields
      if (field.required && (value === undefined || value === '')) {
        newErrors[key] = `${field.title || key} is required`;
        return;
      }

      // Validate number fields
      if (field.type === 'number' && value !== undefined && value !== '') {
        const numValue = Number(value);
        if (isNaN(numValue)) {
          newErrors[key] = 'Must be a valid number';
        } else if (field.min !== undefined && numValue < field.min) {
          newErrors[key] = `Must be at least ${field.min}`;
        } else if (field.max !== undefined && numValue > field.max) {
          newErrors[key] = `Must be at most ${field.max}`;
        }
      }
    });

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleInstall = () => {
    if (validateConfig()) {
      // Convert string numbers to actual numbers for number fields
      const processedConfig: McpServerUserConfigValues = {};
      Object.entries(configValues || {}).forEach(([key, value]) => {
        const field = userConfig[key];
        if (field?.type === 'number' && typeof value === 'string') {
          processedConfig[key] = Number(value);
        } else {
          processedConfig[key] = value;
        }
      });

      onInstall(processedConfig);
    }
  };

  const handleDirectorySelect = async (key: string, multiple?: boolean) => {
    try {
      const res = await window.electronAPI.showOpenDialog({
        properties: multiple ? ['openDirectory', 'multiSelections'] : ['openDirectory'],
      });
      if (!res || res.canceled) return;
      const paths = res.filePaths;
      if (multiple) {
        handleConfigChange(key, paths);
      } else {
        handleConfigChange(key, paths[0]);
      }
    } catch (error) {
      // Fallback alert
      alert('Unable to open directory picker. Please enter the path manually.');
    }
  };

  const handleFileSelect = async (key: string, multiple?: boolean) => {
    try {
      const res = await window.electronAPI.showOpenDialog({
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      });
      if (!res || res.canceled) return;
      const paths = res.filePaths;
      if (multiple) {
        handleConfigChange(key, paths);
      } else {
        handleConfigChange(key, paths[0]);
      }
    } catch (error) {
      // Fallback alert
      alert('Unable to open file picker. Please enter the path manually.');
    }
  };

  const expandEnvVariables = (value: string | string[]): string => {
    if (Array.isArray(value)) {
      return value.map((v) => expandEnvVariables(v)).join(', ');
    }

    // Simple environment variable expansion
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      if (varName === 'HOME') {
        return '~';
      }
      return match;
    });
  };

  /**
   * TODO: figure out a "stronger" way to conditionally render the "userConfig" fields
   * (because the "type" of a user config is dynamic)
   *
   * See the following for some inspiration/ideas:
   * - https://www.typescriptlang.org/docs/handbook/advanced-types.html
   * - https://github.com/anthropics/dxt/blob/main/MANIFEST.md#user-configuration
   */
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure {mcpServer.display_name}</DialogTitle>
          <DialogDescription>
            {hasUserConfig
              ? 'This MCP server requires configuration before installation. Please provide the required values below.'
              : 'Review the installation details below.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {hasOAuth && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                This server requires OAuth authentication. You'll be redirected to complete the authentication flow
                after clicking Install.
              </AlertDescription>
            </Alert>
          )}

          {hasUserConfig && (
            <div className="space-y-4">
              {Object.entries(userConfig).map(([key, field]) => {
                const value = configValues?.[key];
                const error = errors[key];

                if (field.type === 'string') {
                  const isSecret = field.sensitive;
                  const showValue = !isSecret || showSecrets[key];

                  return (
                    <div key={key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={key}>
                          {field.title || key}
                          {field.required && <span className="text-destructive ml-1">*</span>}
                        </Label>
                      </div>
                      <div className="relative">
                        <Input
                          id={key}
                          type={showValue ? 'text' : 'password'}
                          placeholder={field.default ? String(field.default) : `Enter ${field.title || key}`}
                          value={(value as string) || ''}
                          onChange={(e) => handleConfigChange(key, e.target.value)}
                          className={`pr-10 ${error ? 'border-destructive' : ''}`}
                        />
                        {isSecret && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent cursor-pointer"
                            onClick={() => toggleSecretVisibility(key)}
                          >
                            {showValue ? (
                              <EyeOff className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <Eye className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                        )}
                      </div>
                      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                      {error && <p className="text-xs text-destructive">{error}</p>}
                    </div>
                  );
                }

                if (field.type === 'number') {
                  return (
                    <div key={key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={key}>
                          {field.title || key}
                          {field.required && <span className="text-destructive ml-1">*</span>}
                        </Label>
                        {(field.min !== undefined || field.max !== undefined) && (
                          <span className="text-xs text-muted-foreground">
                            {field.min !== undefined && field.max !== undefined
                              ? `${field.min} - ${field.max}`
                              : field.min !== undefined
                                ? `Min: ${field.min}`
                                : `Max: ${field.max}`}
                          </span>
                        )}
                      </div>
                      <Input
                        id={key}
                        type="number"
                        placeholder={field.default?.toString() || `Enter ${field.title || key}`}
                        value={(value as number)?.toString() || ''}
                        onChange={(e) => handleConfigChange(key, e.target.value)}
                        min={field.min}
                        max={field.max}
                        className={error ? 'border-destructive' : ''}
                      />
                      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                      {error && <p className="text-xs text-destructive">{error}</p>}
                    </div>
                  );
                }

                if (field.type === 'boolean') {
                  return (
                    <div key={key} className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Switch
                          id={key}
                          checked={(value as boolean) || false}
                          onCheckedChange={(checked) => handleConfigChange(key, checked)}
                        />
                        <Label htmlFor={key} className="cursor-pointer font-normal">
                          {field.title || key}
                          {field.required && <span className="text-destructive ml-1">*</span>}
                        </Label>
                      </div>
                      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                    </div>
                  );
                }

                if (field.type === 'directory' || field.type === 'file') {
                  const isDirectory = field.type === 'directory';
                  const currentValue = value as string | string[] | undefined;
                  const displayValue = currentValue
                    ? Array.isArray(currentValue)
                      ? currentValue.join(', ')
                      : currentValue
                    : '';

                  return (
                    <div key={key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={key}>
                          {field.title || key}
                          {field.required && <span className="text-destructive ml-1">*</span>}
                        </Label>
                        {field.multiple && (
                          <Badge variant="secondary" className="text-xs">
                            Multiple
                          </Badge>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          id={key}
                          placeholder={
                            field.default
                              ? // Keep arrays as arrays, convert everything else to string
                                expandEnvVariables(Array.isArray(field.default) ? field.default : String(field.default))
                              : `Enter ${isDirectory ? 'directory' : 'file'} path${
                                  field.multiple ? 's (comma-separated)' : ''
                                }`
                          }
                          value={displayValue}
                          onChange={(e) => {
                            const newValue = field.multiple
                              ? e.target.value
                                  .split(',')
                                  .map((v) => v.trim())
                                  .filter(Boolean)
                              : e.target.value;
                            handleConfigChange(key, newValue);
                          }}
                          className={`flex-1 ${error ? 'border-destructive' : ''}`}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="cursor-pointer"
                          onClick={() =>
                            isDirectory
                              ? handleDirectorySelect(key, field.multiple)
                              : handleFileSelect(key, field.multiple)
                          }
                        >
                          {isDirectory ? <Folder className="h-4 w-4" /> : <File className="h-4 w-4" />}
                        </Button>
                      </div>
                      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
                      {field.default && (
                        <p className="text-xs text-muted-foreground">
                          {/* Keep arrays as arrays, convert everything else to string */}
                          Default:{' '}
                          {expandEnvVariables(Array.isArray(field.default) ? field.default : String(field.default))}
                        </p>
                      )}
                      {error && <p className="text-xs text-destructive">{error}</p>}
                    </div>
                  );
                }

                return null;
              })}
            </div>
          )}

          {!hasUserConfig && !hasOAuth && (
            <p className="text-sm text-muted-foreground">This server doesn't require any additional configuration.</p>
          )}
        </div>

        <DialogFooter>
          <Button className="cursor-pointer" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="cursor-pointer" onClick={handleInstall} disabled={Object.keys(errors).length > 0}>
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
