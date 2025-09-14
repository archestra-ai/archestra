import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, Bot, Check, CheckCircle, Clock, Cpu, Download, HardDrive, Loader2, Search, Type, Wrench } from 'lucide-react';
import { useState } from 'react';

import DetailedProgressBar from '@ui/components/DetailedProgressBar';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { Checkbox } from '@ui/components/ui/checkbox';
import { Input } from '@ui/components/ui/input';
import { ScrollArea } from '@ui/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui/components/ui/select';
import { useAllAvailableModelLabels, useAvailableModels, useOllamaStore } from '@ui/stores';

export const Route = createFileRoute('/llm-providers/ollama')({
  component: OllamaProviderPage,
});

function OllamaProviderPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLabel, setSelectedLabel] = useState<string>('all');
  const [toolCallsOnly, setToolCallsOnly] = useState(false);

  const { installedModels, downloadModel, downloadProgress, modelsBeingDownloaded, requiredModelsStatus, requiredModelsDownloadProgress, loadingRequiredModels } = useOllamaStore();

  const availableModels = useAvailableModels();
  const allAvailableModelLabels = useAllAvailableModelLabels();

  const filteredModels = availableModels.filter((model) => {
    const matchesSearch =
      model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.labels.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesLabel = selectedLabel === 'all' || model.labels.includes(selectedLabel);

    const matchesToolCalls = !toolCallsOnly || model.labels.includes('tools');

    return matchesSearch && matchesLabel && matchesToolCalls;
  });

  const isModelInstalled = (modelName: string) => {
    return installedModels.some((model) => model.name === modelName);
  };

  const formatFileSize = (sizeStr: string) => {
    // Convert size strings like "7b", "13b", "70b" to more readable format
    if (sizeStr.endsWith('b')) {
      const num = parseFloat(sizeStr.slice(0, -1));
      if (num >= 1000) {
        return `${(num / 1000).toFixed(1)}T`;
      }
      return `${num}B`;
    }
    return sizeStr;
  };

  return (
    <>
      <div className="space-y-3 mb-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Local Models
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Required Models</h3>
              <p className="text-sm text-muted-foreground">
                We ensure that the following models are installed and available for use for various AI features throughout
                the application.
              </p>
              {loadingRequiredModels ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking model status...
                </div>
              ) : (
                <div className="space-y-2">
                  {requiredModelsStatus.map(({ model: modelName, reason, installed }) => {
                    const modelDownloadProgress = requiredModelsDownloadProgress[modelName];
                    const iconDownloadProgressStatusMap = {
                      downloading: <Loader2 className="h-4 w-4 animate-spin" />,
                      verifying: <CheckCircle className="h-4 w-4 text-green-500" />,
                      completed: <CheckCircle className="h-4 w-4 text-green-500" />,
                      error: <AlertCircle className="h-4 w-4 text-red-500" />,
                    };
                    let icon: React.JSX.Element;

                    if (installed) {
                      icon = iconDownloadProgressStatusMap['completed'];
                    } else {
                      icon = iconDownloadProgressStatusMap[modelDownloadProgress?.status || 'verifying'];
                    }

                    return (
                      <DetailedProgressBar
                        key={modelName}
                        icon={icon}
                        title={modelName}
                        description={reason}
                        percentage={modelDownloadProgress?.progress}
                        error={modelDownloadProgress?.status === 'error' ? modelDownloadProgress?.message : null}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-bold">Local Model Library</h1>
          <p className="text-muted-foreground">Discover and download AI models to run locally on your device</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              placeholder="Search models by name, description, or tags..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          <div className="flex items-center space-x-3">
            <Checkbox
              id="tool-calls-filter"
              checked={toolCallsOnly}
              onCheckedChange={(checked) => setToolCallsOnly(checked === true)}
            />
            <label
              htmlFor="tool-calls-filter"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 flex items-center gap-1"
            >
              <Wrench className="h-4 w-4" />
              Tool calling models
            </label>
          </div>

          <Select value={selectedLabel} onValueChange={setSelectedLabel}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {allAvailableModelLabels.map((label) => (
                <SelectItem key={label} value={label}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ScrollArea className="h-[600px]">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pb-4">
          {filteredModels.map((model) => (
            <Card key={model.name} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{model.name}</CardTitle>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{model.description}</p>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {model.labels.map((label) => (
                    <Badge key={label} variant="outline" className="text-xs">
                      {label}
                    </Badge>
                  ))}
                </div>

                <div className="space-y-3">
                  <div className="text-sm font-medium flex items-center gap-1">
                    <HardDrive className="h-4 w-4" />
                    Available Sizes
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    {model.tags.map(({ tag, context, size, inputs }) => {
                      const fullModelName = `${model.name}:${tag}`;
                      const progress = downloadProgress[fullModelName];
                      const isDownloading = modelsBeingDownloaded.has(fullModelName);
                      const isInstalled = isModelInstalled(fullModelName);

                      return (
                        <div key={tag} className="p-3 rounded border space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Cpu className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-mono font-medium">{tag}</span>
                            </div>

                            <Button
                              size="sm"
                              variant={isInstalled ? 'secondary' : 'default'}
                              disabled={isDownloading}
                              onClick={() => downloadModel(fullModelName)}
                              className="h-8 px-3 cursor-pointer"
                            >
                              {isDownloading ? (
                                <div className="flex items-center gap-1">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  <span className="text-xs">{progress ? `${progress}%` : '...'}</span>
                                </div>
                              ) : isInstalled ? (
                                <div className="flex items-center gap-1">
                                  <Check className="h-3 w-3" />
                                  <span className="text-xs">Installed</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <Download className="h-3 w-3" />
                                  <span className="text-xs">Download</span>
                                </div>
                              )}
                            </Button>
                          </div>

                          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                            {size && (
                              <div className="flex items-center gap-1">
                                <HardDrive className="h-3 w-3" />
                                <span>{formatFileSize(size)}</span>
                              </div>
                            )}
                            {context && (
                              <div className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                <span>{context} context</span>
                              </div>
                            )}
                            {inputs && inputs.length > 0 && (
                              <div className="flex items-center gap-1">
                                <Type className="h-3 w-3" />
                                <span>Inputs: {inputs.join(', ')}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {filteredModels.length === 0 && (
          <div className="text-center py-12">
            <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No models found</h3>
            <p className="text-muted-foreground">Try adjusting your search terms or category filter</p>
          </div>
        )}
      </ScrollArea>
    </>
  );
}
