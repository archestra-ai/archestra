import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, Bot, Check, CheckCircle, Clock, Cpu, Download, HardDrive, Loader2 } from 'lucide-react';

import DetailedProgressBar from '@ui/components/DetailedProgressBar';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { useAvailableModels, useOllamaStore } from '@ui/stores';

export const Route = createFileRoute('/llm-providers/ollama')({
  component: OllamaProviderPage,
});

function OllamaProviderPage() {
  const {
    installedModels,
    downloadModel,
    downloadProgress,
    modelsBeingDownloaded,
    requiredModelsStatus,
    requiredModelsDownloadProgress,
    loadingRequiredModels,
  } = useOllamaStore();

  const availableModels = useAvailableModels();

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
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="h-6 w-6" />
            Local Models
          </h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Required Models</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                We ensure that the following models are installed and available for use for various AI features
                throughout the application.
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

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {availableModels.map((model) => (
            <Card key={model.name} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">{model.name}</CardTitle>
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
                  <div className="grid grid-cols-1 gap-2">
                    {model.tags.map(({ tag, context, size, inputs }) => {
                      const fullModelName = `${model.name}:${tag}`;
                      const progress = downloadProgress[fullModelName];
                      const isDownloading = modelsBeingDownloaded.has(fullModelName);
                      const isInstalled = isModelInstalled(fullModelName);

                      return (
                        <div key={tag} className="p-2 rounded border flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                              <Cpu className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-mono font-medium">{tag}</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              {size && (
                                <div className="flex items-center gap-1">
                                  <HardDrive className="h-3 w-3" />
                                  <span>{formatFileSize(size)}</span>
                                </div>
                              )}
                              {context && (
                                <div className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  <span>{context}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          <Button
                            size="sm"
                            variant={isInstalled ? 'secondary' : 'default'}
                            disabled={isDownloading}
                            onClick={() => downloadModel(fullModelName)}
                            className="h-7 px-2 cursor-pointer"
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
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
