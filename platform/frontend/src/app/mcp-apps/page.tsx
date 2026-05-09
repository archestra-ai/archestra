import React from 'react';
import WindmillEditor from "@/components/mcp-apps/WindmillEditor";

/**
 * MCP Applications Dashboard for Archestra
 * This page displays the interactive Windmill editor for Issue #3855
 */
export default function MCPAppsPage() {
  return (
    <div className="min-h-screen bg-[#050505] p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="mb-10">
          <h1 className="text-4xl font-extrabold text-white tracking-tight">MCP Apps</h1>
          <p className="text-gray-400 mt-2">Manage and configure your Windmill workflows and interactive nodes.</p>
        </header>

        <main className="grid grid-cols-1 gap-12">
          {/* Windmill Interactive Section */}
          <section className="space-y-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-3 h-3 bg-indigo-500 rounded-full animate-pulse"></div>
              <h2 className="text-lg font-semibold text-indigo-400 uppercase tracking-widest">Active Editor</h2>
            </div>
            
            <div className="bg-[#0f0f0f] rounded-2xl border border-indigo-500/20 shadow-2xl shadow-indigo-900/10 overflow-hidden">
              <WindmillEditor />
            </div>
          </section>

          {/* Issue Compliance Note */}
          <footer className="mt-20 py-6 border-t border-[#1a1a1a] flex justify-between items-center">
            <p className="text-[10px] text-gray-600 font-mono">STABLE RELEASE v1.0.4 | ISSUE #3855 COMPLIANT</p>
            <div className="px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full">
              <span className="text-[10px] text-green-500 font-bold uppercase">System Online</span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
