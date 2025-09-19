import { FileText, GitBranch, Home, Package, Shield } from 'lucide-react';

import { Badge } from '@ui/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import { ScrollArea } from '@ui/components/ui/scroll-area';
import { Separator } from '@ui/components/ui/separator';
import { ArchestraMcpServerManifest } from '@ui/lib/clients/archestra/catalog/gen';

interface McpServerDetailsDialogProps {
  server: ArchestraMcpServerManifest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function McpServerDetailsDialog({ server, open, onOpenChange }: McpServerDetailsDialogProps) {
  if (!server) return null;

  const {
    name,
    display_name,
    description,
    long_description,
    author,
    homepage,
    documentation,
    license,
    tools,
    prompts,
    keywords,
    compatibility,
    github_info,
    quality_score,
    protocol_features,
    dependencies,
    readme,
  } = server;

  const displayName = display_name || name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="text-xl">{displayName}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[60vh] pr-4">
          <div className="space-y-6">
            {/* Version and Quality Score */}
            <div className="flex items-center gap-4">
              {quality_score && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Trust Score:</span>
                  <span className="font-semibold">{quality_score}/100</span>
                  <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 transition-all" style={{ width: `${quality_score}%` }} />
                  </div>
                </div>
              )}
            </div>

            {/* Long Description */}
            {long_description && (
              <div>
                <h3 className="font-semibold mb-2">About</h3>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{long_description}</p>
              </div>
            )}

            <Separator />

            {/* Author and Links */}
            <div>
              <h3 className="font-semibold mb-3">Information</h3>
              <div className="space-y-2">
                {author && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Author:</span> {author.name}
                    {author.email && <span className="text-muted-foreground"> ({author.email})</span>}
                  </div>
                )}
                {license && (
                  <div className="text-sm flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">License:</span> {license}
                  </div>
                )}
                <div className="flex flex-wrap gap-3 mt-3">
                  {github_info?.url && (
                    <a
                      href={github_info.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
                    >
                      <GitBranch className="h-4 w-4" />
                      GitHub
                    </a>
                  )}
                  {homepage && (
                    <a
                      href={homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
                    >
                      <Home className="h-4 w-4" />
                      Homepage
                    </a>
                  )}
                  {documentation && (
                    <a
                      href={documentation}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm text-blue-600 hover:underline"
                    >
                      <FileText className="h-4 w-4" />
                      Documentation
                    </a>
                  )}
                </div>
              </div>
            </div>

            <Separator />

            {/* Tools */}
            {tools && tools.length > 0 && (
              <div>
                <h3 className="font-semibold mb-3">Available Tools ({tools.length})</h3>
                <div className="space-y-2">
                  {tools.map((tool, index) => (
                    <div key={index} className="border rounded-lg p-3">
                      <h4 className="font-medium text-sm">{tool.name}</h4>
                      {tool.description && <p className="text-xs text-muted-foreground mt-1">{tool.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Prompts */}
            {prompts && prompts.length > 0 && (
              <div>
                <h3 className="font-semibold mb-3">Available Prompts ({prompts.length})</h3>
                <div className="space-y-2">
                  {prompts.map((prompt, index) => (
                    <div key={index} className="border rounded-lg p-3">
                      <h4 className="font-medium text-sm">{prompt.name}</h4>
                      {prompt.description && <p className="text-xs text-muted-foreground mt-1">{prompt.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Keywords */}
            {keywords && keywords.length > 0 && (
              <div>
                <h3 className="font-semibold mb-3">Keywords</h3>
                <div className="flex flex-wrap gap-2">
                  {keywords.map((keyword, index) => (
                    <Badge key={index} variant="outline" className="text-xs">
                      {keyword}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Compatibility */}
            {compatibility && (
              <div>
                <h3 className="font-semibold mb-3">Compatibility</h3>
                <div className="space-y-2 text-sm">
                  {compatibility.platforms && (
                    <div>
                      <span className="text-muted-foreground">Platforms:</span>{' '}
                      {compatibility.platforms.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(', ')}
                    </div>
                  )}
                  {compatibility.runtimes?.python && (
                    <div>
                      <span className="text-muted-foreground">Python:</span> {compatibility.runtimes.python}
                    </div>
                  )}
                  {compatibility.runtimes?.node && (
                    <div>
                      <span className="text-muted-foreground">Node.js:</span> {compatibility.runtimes.node}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Protocol Features */}
            {protocol_features && (
              <div>
                <h3 className="font-semibold mb-3">Protocol Features</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {Object.entries(protocol_features).map(([feature, implemented]) => (
                    <div key={feature} className="flex items-center gap-2">
                      <span className={implemented ? 'text-green-600' : 'text-muted-foreground'}>
                        {implemented ? '✓' : '✗'}
                      </span>
                      <span className="text-muted-foreground">
                        {feature.replace('implementing_', '').replace(/_/g, ' ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dependencies */}
            {dependencies && dependencies.length > 0 && (
              <div>
                <h3 className="font-semibold mb-3">Key Dependencies</h3>
                <div className="flex flex-wrap gap-2">
                  {dependencies.slice(0, 10).map((dep, index) => (
                    <Badge key={index} variant="outline" className="text-xs">
                      <Package className="h-3 w-3 mr-1" />
                      {dep.name}
                    </Badge>
                  ))}
                  {dependencies.length > 10 && (
                    <Badge variant="outline" className="text-xs">
                      +{dependencies.length - 10} more
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {/* README Preview */}
            {readme && (
              <div>
                <h3 className="font-semibold mb-3">README Preview</h3>
                <div className="border rounded-lg p-4 bg-muted/30">
                  <pre className="text-xs whitespace-pre-wrap font-mono">
                    {readme.slice(0, 500)}
                    {readme.length > 500 && '...'}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
