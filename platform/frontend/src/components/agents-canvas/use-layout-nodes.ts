"use client";

import type { Edge, Node } from "@xyflow/react";
import { useCallback } from "react";
import type { AgentNodeData } from "./agent-node";

interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  ports?: Array<{
    id: string;
    properties?: Record<string, string>;
  }>;
  edges?: Array<{
    id: string;
    sources: string[];
    targets: string[];
  }>;
  layoutOptions?: Record<string, string>;
  properties?: Record<string, string>;
}

interface ELKInstance {
  layout: (graph: ElkNode) => Promise<ElkNode>;
}

// Lazy load ELK to handle dynamic import
let elkInstance: ELKInstance | null = null;

async function getElk(): Promise<ELKInstance> {
  if (!elkInstance) {
    // elkjs is a CommonJS module without proper type declarations
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of untyped module
    const ELK = (await import("elkjs/lib/elk.bundled.js" as any)).default;
    elkInstance = new ELK() as ELKInstance;
  }
  return elkInstance;
}

// ELK layout options for hierarchical left-to-right layout
const layoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.componentComponent": "60",
  "elk.layered.compaction.connectedComponents": "true",
};

export function useLayoutNodes() {
  const getLayoutedNodes = useCallback(
    async (
      nodes: Node<AgentNodeData>[],
      edges: Edge[],
    ): Promise<Node<AgentNodeData>[]> => {
      if (nodes.length === 0) return nodes;

      // Build set of valid node IDs for filtering edges
      const nodeIds = new Set(nodes.map((n) => n.id));

      // Filter edges to only include those with valid source and target nodes
      const validEdges = edges.filter(
        (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
      );

      // Build ELK graph structure
      const elkGraph: ElkNode = {
        id: "root",
        layoutOptions,
        children: nodes.map((node) => ({
          id: node.id,
          width: 180,
          height: 80,
          // Define ports for handles
          ports: [
            {
              id: `${node.id}-target`,
              properties: {
                side: "WEST",
              },
            },
            {
              id: `${node.id}-source-tools`,
              properties: {
                side: "EAST",
              },
            },
          ],
          properties: {
            "org.eclipse.elk.portConstraints": "FIXED_SIDE",
          },
        })),
        edges: validEdges.map((edge) => ({
          id: edge.id,
          sources: [`${edge.source}-source-${edge.sourceHandle || "tools"}`],
          targets: [`${edge.target}-target`],
        })),
      };

      try {
        const elk = await getElk();
        const layoutedGraph = await elk.layout(elkGraph);

        // Map layouted positions back to nodes
        const layoutedNodes = nodes.map((node) => {
          const layoutedNode = layoutedGraph.children?.find(
            (n: ElkNode) => n.id === node.id,
          );
          if (layoutedNode) {
            return {
              ...node,
              position: {
                x: layoutedNode.x ?? 0,
                y: layoutedNode.y ?? 0,
              },
            };
          }
          return node;
        });

        return layoutedNodes;
      } catch (error) {
        console.error("ELK layout error:", error);
        return nodes;
      }
    },
    [],
  );

  return { getLayoutedNodes };
}
