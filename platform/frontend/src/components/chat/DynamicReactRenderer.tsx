import React, { Suspense, useState } from 'react';
import { McpUiMetadata } from '../../mcp-ui.types';

interface DynamicRendererProps {
  metadata: McpUiMetadata;
  data: any;
}

/**
 * Renderizador Dinámico Artístico
 * Muestra tablas y datos con efectos de cristal y funciones de copiado
 */
export const DynamicReactRenderer: React.FC<DynamicRendererProps> = ({ metadata, data }) => {
  const { componentName, props } = metadata;
  const [copied, setCopied] = useState(false);

  // Función para copiar al portapapeles con feedback visual
  const handleCopy = (content: any) => {
    navigator.clipboard.writeText(JSON.stringify(content, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderArtisticTable = (rawData: any) => {
    const tableData = Array.isArray(rawData) ? rawData : (rawData?.items || []);
    
    if (!tableData.length || typeof tableData[0] !== 'object') {
      return (
        <div className="relative group/pre">
          <button 
            onClick={() => handleCopy(rawData)}
            className="absolute right-2 top-2 z-30 p-1.5 rounded bg-white/5 border border-white/10 hover:bg-white/10 transition-all text-xs"
          >
            {copied ? "✅" : "📋"}
          </button>
          <pre className="mcp-ui-preformatted">{JSON.stringify(rawData, null, 2)}</pre>
        </div>
      );
    }

    const headers = Object.keys(tableData[0]);

    return (
      <div className="mcp-ui-table-container relative group/table">
        {/* Botón de Copiar Flotante para la Tabla */}
        <button 
          onClick={() => handleCopy(tableData)}
          className="absolute right-4 top-4 z-20 p-2 rounded-lg bg-white/10 border border-white/10 hover:bg-primary/20 hover:border-primary/50 transition-all duration-300 opacity-0 group-hover/table:opacity-100 shadow-xl"
          title="Copiar datos JSON"
        >
          {copied ? "✅" : "📋"}
        </button>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="mcp-ui-table-header">
                {headers.map((header) => (
                  <th key={header} className="p-4 text-[10px] tracking-[0.2em]">
                    {header.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableData.map((row: any, i: number) => (
                <tr key={i} className="mcp-ui-table-row group">
                  {headers.map((header) => (
                    <td key={header} className="mcp-ui-table-cell group-hover:text-white transition-colors duration-300">
                      {typeof row[header] === 'number' ? (
                        <span className="font-mono text-indigo-400 font-bold">
                          {row[header].toLocaleString()}
                        </span>
                      ) : (
                        String(row[header] ?? "")
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <Suspense fallback={
      <div className="animate-pulse p-8 bg-slate-900/20 rounded-xl border border-white/5 flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Sincronizando MCP...</span>
      </div>
    }>
      <div className="mcp-ui-container group/container relative overflow-hidden">
        {/* Luz ambiental decorativa */}
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-primary/5 rounded-full blur-3xl transition-all group-hover/container:bg-primary/10" />
        
        <div className="mcp-ui-content relative z-10">
          <div className="flex items-center justify-between mb-6 border-b border-white/5 pb-4">
            <div className="flex flex-col">
              <h4 className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500">
                {componentName || 'Dynamic Output'}
              </h4>
              <span className="text-[9px] text-slate-600 font-medium tracking-tight uppercase">Data Visualization Engine</span>
            </div>
            <span className="mcp-live-badge">
              MCP Live
            </span>
          </div>
          
          {Array.isArray(data) || componentName === 'DataTable' ? (
            renderArtisticTable(data || props)
          ) : (
            <div className="relative group/pre">
              {/* Botón de Copiar para formato JSON estándar */}
              <button 
                onClick={() => handleCopy(data || props)}
                className="absolute right-3 top-3 z-20 p-1.5 rounded-lg bg-white/5 border border-white/10 opacity-0 group-hover/pre:opacity-100 transition-all hover:bg-white/10"
              >
                {copied ? "✅" : "📋"}
              </button>
              <div className="rounded-xl bg-black/20 p-4 border border-white/5">
                <pre className="mcp-ui-preformatted text-indigo-300/80 text-xs">
                  {JSON.stringify(data || props, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </Suspense>
  );
};