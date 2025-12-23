import React from 'react';
import { DynamicReactRenderer } from './DynamicReactRenderer';
import { McpUiMetadata } from '../../mcp-ui.types';

interface ToolOutputWithUiProps {
  content: any;
  ui?: McpUiMetadata;
  isError?: boolean;
}

export const ToolOutputWithUi: React.FC<ToolOutputWithUiProps> = ({ content, ui, isError }) => {
  // Si hay un error, mostramos el estilo de error
  if (isError) {
    return (
      <div className="mcp-ui-error my-2">
        <p className="font-bold mb-1">Error en la herramienta:</p>
        <pre className="text-xs opacity-80">{JSON.stringify(content, null, 2)}</pre>
      </div>
    );
  }

  // Si el servidor mandó instrucciones de UI, usamos nuestro nuevo renderizador
  if (ui) {
    return <DynamicReactRenderer metadata={ui} data={content} />;
  }

  // Si no hay UI, volvemos al comportamiento por defecto (texto crudo)
  return (
    <div className="mt-2 text-sm text-foreground/80 italic">
      {typeof content === 'string' ? content : JSON.stringify(content)}
    </div>
  );
};