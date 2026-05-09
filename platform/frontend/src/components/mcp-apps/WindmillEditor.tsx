import React, { useState } from 'react';

/**
 * Windmill Interactive Node Editor
 * Designed for Archestra - Compliance with Issue #3855
 */
const WindmillEditor: React.FC = () => {
  // Demo states for nodes to show interactivity
  const [nodes, setNodes] = useState([
    { id: 1, name: 'Confluence Source', icon: '📄', color: 'bg-blue-500' },
    { id: 2, name: 'Email Automation', icon: '📧', color: 'bg-green-500' }
  ]);

  return (
    <div className="flex flex-col w-full h-[400px] bg-[#0a0a0a] text-white p-6 rounded-2xl border border-[#222] shadow-2xl font-sans">
      {/* Header Area */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Windmill MCP Workflow</h2>
          <p className="text-xs text-gray-500 mt-1">Interactive Node-based Editor for Archestra</p>
        </div>
        <button className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition-all shadow-lg shadow-indigo-900/30">
          Deploy Flow
        </button>
      </div>

      {/* Interactive Canvas Area */}
      <div className="relative flex-grow bg-[#111] rounded-xl border border-dashed border-[#333] p-6 overflow-hidden">
        <div className="flex flex-wrap gap-8 justify-center items-center h-full">
          {nodes.map((node) => (
            <div 
              key={node.id} 
              className="group relative flex flex-col items-center p-4 w-40 bg-[#1a1a1a] border border-[#333] rounded-xl hover:border-indigo-500 transition-all cursor-move shadow-md"
            >
              <div className={`w-12 h-12 ${node.color} rounded-lg flex items-center justify-center text-2xl mb-3 shadow-inner`}>
                {node.icon}
              </div>
              <span className="text-sm font-medium text-gray-300">{node.name}</span>
              
              {/* Connector dots to show it's part of a flow */}
              <div className="absolute -right-2 top-1/2 w-4 h-4 bg-indigo-500 rounded-full border-4 border-[#0a0a0a] hidden group-hover:block"></div>
              <div className="absolute -left-2 top-1/2 w-4 h-4 bg-indigo-500 rounded-full border-4 border-[#0a0a0a] hidden group-hover:block"></div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer Meta */}
      <div className="mt-6 flex justify-between items-center text-[10px] text-gray-600 uppercase tracking-widest font-bold">
        <span>System: Windmill MCP v1.0</span>
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
          Ready for #3855
        </span>
      </div>
    </div>
  );
};

export default WindmillEditor;
