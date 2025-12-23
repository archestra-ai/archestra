"use client";

import { 
  ExternalLink, Download, Star, Tag, Database, Cpu, 
  FileText, Globe, Box, Layers, Info 
} from "lucide-react";

export function ResourceRenderer({ output }: { output: any }) {
  let data = output;
  
  try {
    if (typeof output === 'string') data = JSON.parse(output);
  } catch (e) { return null; }

  if (!data) return null;

  // Normalización: Aseguramos que siempre sea un array
  const items = Array.isArray(data) ? data : [data];

  return (
    <div className="w-full my-4 space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* Badge de identificación de MCP-UI */}
      <div className="flex items-center gap-2 px-3 py-1.5 w-fit rounded-full bg-primary/10 border border-primary/20 shadow-sm">
        <Layers className="w-3.5 h-3.5 text-primary animate-pulse" />
        <span className="text-[10px] font-bold text-primary uppercase tracking-widest">
          Rich MCP Interface
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.slice(0, 6).map((item: any, i: number) => {
          // Lógica de detección de tipo mejorada
          const isModel = item.id && (item.downloads !== undefined || item.likes !== undefined);
          const isServer = item.name && item.version || item.id?.includes('-');
          const isFile = item.path || item.fileName;
          
          return (
            <div key={item.id || i} className="group relative flex flex-col bg-card border border-border rounded-2xl p-[1px] overflow-hidden transition-all duration-300 hover:shadow-xl hover:shadow-primary/10 hover:-translate-y-1">
              {/* Efecto Glow al pasar el mouse */}
              <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              
              <div className="relative bg-card rounded-[15px] p-4 flex flex-col h-full z-10">
                <div className="flex items-start justify-between mb-4">
                  <div className={`p-2.5 rounded-xl ${isModel ? 'bg-blue-500/10 text-blue-500' : isServer ? 'bg-purple-500/10 text-purple-500' : 'bg-primary/10 text-primary'}`}>
                    {isModel ? <Cpu className="w-5 h-5" /> : isServer ? <Database className="w-5 h-5" /> : isFile ? <FileText className="w-5 h-5" /> : <Box className="w-5 h-5" />}
                  </div>
                  
                  <div className="flex gap-1">
                    {(item.url || item.id) && (
                      <a 
                        href={item.url || (isModel ? `https://huggingface.co/${item.id}` : '#')} 
                        target="_blank" 
                        rel="noreferrer"
                        className="p-2 hover:bg-secondary rounded-full transition-all text-muted-foreground hover:text-primary"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </div>

                <div className="space-y-1 mb-4">
                  <h4 className="font-bold text-sm tracking-tight truncate pr-4 group-hover:text-primary transition-colors">
                    {item.name || item.id?.split('/').pop() || item.title || "Recurso MCP"}
                  </h4>
                  <p className="text-[10px] text-muted-foreground font-mono truncate opacity-70">
                    {item.id || item.path || "mcp-identifier"}
                  </p>
                </div>

                {/* Footer Adaptativo */}
                <div className="flex flex-wrap gap-2 mt-auto pt-4 border-t border-border/50">
                  {/* Stats de HuggingFace si existen */}
                  {item.downloads !== undefined && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 text-[10px] font-bold">
                      <Download className="w-3 h-3 text-blue-500" />
                      {item.downloads > 1000 ? (item.downloads/1000).toFixed(1)+'k' : item.downloads}
                    </div>
                  )}
                  
                  {item.likes !== undefined && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 text-[10px] font-bold">
                      <Star className="w-3 h-3 text-yellow-500" />
                      {item.likes}
                    </div>
                  )}

                  {/* Renderizado Seguro de Tags (Solo si son un Array) */}
                  {Array.isArray(item.tags) && item.tags.slice(0, 2).map((tag: any, idx: number) => (
                    <div key={idx} className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/5 border border-primary/10 text-[9px] font-medium text-primary uppercase">
                      <Tag className="w-2.5 h-2.5" /> {typeof tag === 'string' ? tag.split(':').pop() : 'tag'}
                    </div>
                  ))}

                  {/* Info Badge para Servidores o Recursos sin Metadatos */}
                  {(item.version || (!item.downloads && !item.tags)) && (
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 text-[10px] text-muted-foreground">
                      <Info className="w-3 h-3" />
                      <span>{item.version ? `v${item.version}` : 'Detalles'}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}