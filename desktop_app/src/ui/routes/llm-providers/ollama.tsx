import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, Bot, Check, CheckCircle, Clock, Cpu, Download, HardDrive, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import DetailedProgressBar from '@ui/components/DetailedProgressBar';
import { Alert, AlertDescription } from '@ui/components/ui/alert';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ui/components/ui/dialog';
import { useAvailableModels, useOllamaStore } from '@ui/stores';

export const Route = createFileRoute('/llm-providers/ollama')({
  component: OllamaProviderPage,
});

function OllamaProviderPage() {
  const [modelsBeingUninstalled, setModelsBeingUninstalled] = useState<Set<string>>(new Set());
  const [modelToUninstall, setModelToUninstall] = useState<string | null>(null);
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);
  const [showSuccessMessage, setShowSuccessMessage] = useState<string | null>(null);
  const [showErrorMessage, setShowErrorMessage] = useState<string | null>(null);
  const {
    installedModels,
    downloadModel,
    uninstallModel,
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

  const handleUninstallClick = (fullModelName: string) => {
    console.log('Uninstall clicked for:', fullModelName);
    setModelToUninstall(fullModelName);
    setShowUninstallDialog(true);
  };

  const handleConfirmUninstall = async () => {
    if (!modelToUninstall) return;

    setShowUninstallDialog(false);
    setModelsBeingUninstalled((prev) => new Set([...prev, modelToUninstall]));

    try {
      await uninstallModel(modelToUninstall);

      // Show success message
      setShowSuccessMessage(`Successfully uninstalled ${modelToUninstall}`);
      setTimeout(() => setShowSuccessMessage(null), 3000);
    } catch (error) {
      console.error('Failed to uninstall model:', error);

      // Show error message
      setShowErrorMessage(`Failed to uninstall ${modelToUninstall}. Please try again.`);
      setTimeout(() => setShowErrorMessage(null), 5000);
    } finally {
      setModelsBeingUninstalled((prev) => {
        const newSet = new Set(prev);
        newSet.delete(modelToUninstall);
        return newSet;
      });
      setModelToUninstall(null);
    }
  };

  const handleCancelUninstall = () => {
    setShowUninstallDialog(false);
    setModelToUninstall(null);
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
        {showSuccessMessage && (
          <Alert className="border-green-200 bg-green-50 dark:border-green-900/40 dark:bg-green-900/20">
            <AlertDescription>{showSuccessMessage}</AlertDescription>
          </Alert>
        )}
        {showErrorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{showErrorMessage}</AlertDescription>
          </Alert>
        )}
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

        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
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
                      const isUninstalling = modelsBeingUninstalled.has(fullModelName);
                      const isInstalled = isModelInstalled(fullModelName);
                      const isRequired = requiredModelsStatus.some(
                        ({ model: requiredModel }) => requiredModel === fullModelName
                      );

                      return (
                        <div key={tag} className="p-3 rounded border flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
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
                          <div className="flex items-center gap-1 sm:gap-2 lg:gap-1 2xl:gap-2 shrink-0 ml-1 sm:ml-2 lg:ml-1 2xl:ml-2">
                            <Button
                              size="sm"
                              variant={isInstalled ? 'secondary' : 'default'}
                              disabled={isDownloading}
                              onClick={() => !isInstalled && downloadModel(fullModelName)}
                              aria-label={
                                isDownloading
                                  ? `Downloading ${fullModelName}`
                                  : isInstalled
                                    ? `${fullModelName} installed`
                                    : `Download ${fullModelName}`
                              }
                              className={`h-6 sm:h-7 max-[420px]:w-6 w-auto px-2 max-[420px]:px-0 min-[1024px]:px-1 min-[1056px]:px-2 justify-center text-xs whitespace-nowrap ${isInstalled ? 'cursor-default' : 'cursor-pointer'}`}
                            >
                              {isDownloading ? (
                                <div className="flex items-center gap-1">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  <span className="text-xs max-[420px]:hidden min-[1024px]:hidden min-[1056px]:inline">
                                    {progress ? `${progress}%` : '...'}
                                  </span>
                                </div>
                              ) : isInstalled ? (
                                <div className="flex items-center gap-1">
                                  <Check className="h-3 w-3" />
                                  <span className="text-xs max-[420px]:hidden min-[1024px]:hidden min-[1056px]:inline">
                                    Installed
                                  </span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <Download className="h-3 w-3" />
                                  <span className="text-xs max-[420px]:hidden min-[1024px]:hidden min-[1056px]:inline">
                                    Download
                                  </span>
                                </div>
                              )}
                            </Button>

                            {isInstalled && !isRequired && (
                              <Button
                                size="icon"
                                variant="destructive"
                                disabled={isUninstalling || isDownloading}
                                onClick={() => handleUninstallClick(fullModelName)}
                                className="h-6 w-6 sm:h-7 sm:w-7 cursor-pointer hover:bg-destructive/95 dark:hover:bg-destructive/80 shrink-0"
                                title="Uninstall model"
                              >
                                {isUninstalling ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
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
      </div>

      {/* Uninstall confirmation dialog */}
      <Dialog open={showUninstallDialog} onOpenChange={setShowUninstallDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall model</DialogTitle>
            <DialogDescription>
              {modelToUninstall
                ? `Are you sure you want to uninstall ${modelToUninstall}? This will remove the model from disk.`
                : 'Are you sure you want to uninstall this model?'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={handleCancelUninstall}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirmUninstall}>
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
