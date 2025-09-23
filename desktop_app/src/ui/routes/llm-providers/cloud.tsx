import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import CloudProviderConfigDialog from '@ui/components/CloudProviderConfigDialog';
import { Button } from '@ui/components/ui/button';
import { Card } from '@ui/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui/components/ui/tooltip';
import { CloudProviderWithConfig } from '@ui/lib/clients/archestra/api/gen/types.gen';
import { useCloudProvidersStore } from '@ui/stores';

export const Route = createFileRoute('/llm-providers/cloud')({
  component: CloudProviders,
});

function CloudProviders() {
  const { cloudProviders, deleteCloudProvider } = useCloudProvidersStore();
  const [selectedProvider, setSelectedProvider] = useState<CloudProviderWithConfig | null>(null);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Cloud Models</h1>
        <p className="text-muted-foreground">Configure cloud-based AI model providers</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {cloudProviders.map((provider) => (
          <Card key={provider.type} className="p-4">
            <h3 className="font-semibold">{provider.name}</h3>
            <div className="mt-2 text-sm text-muted-foreground">
              {provider.configured ? '✓ Configured' : 'Not configured'}
            </div>
            <div className="mt-4 flex gap-2">
              {provider.type === 'openai' || provider.type === 'archestra' ? (
                <>
                  <Button
                    onClick={() => setSelectedProvider(provider)}
                    variant={provider.configured ? 'outline' : 'default'}
                    size="sm"
                  >
                    {provider.configured ? 'Reconfigure' : 'Configure'}
                  </Button>
                  {provider.configured && (
                    <Button
                      className="cursor-pointer"
                      onClick={() => deleteCloudProvider(provider.type)}
                      variant="destructive"
                      size="sm"
                    >
                      Remove
                    </Button>
                  )}
                </>
              ) : (
                <>
                  {!provider.configured ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button className="cursor-not-allowed opacity-50" variant="default" size="sm" disabled>
                            Configure
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>This feature is not available yet</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button className="cursor-not-allowed opacity-50" variant="outline" size="sm" disabled>
                              Reconfigure
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>This feature is not available yet</p>
                        </TooltipContent>
                      </Tooltip>
                      <Button
                        className="cursor-pointer"
                        onClick={() => deleteCloudProvider(provider.type)}
                        variant="destructive"
                        size="sm"
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          </Card>
        ))}
      </div>

      {selectedProvider && (
        <CloudProviderConfigDialog provider={selectedProvider} onClose={() => setSelectedProvider(null)} />
      )}
    </>
  );
}
