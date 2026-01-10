"use client";

import type { Node, NodeChange, XYPosition } from "@xyflow/react";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getOverlap(rectA: Rect, rectB: Rect): XYPosition | null {
  const xOverlap =
    Math.min(rectA.x + rectA.width, rectB.x + rectB.width) -
    Math.max(rectA.x, rectB.x);
  const yOverlap =
    Math.min(rectA.y + rectA.height, rectB.y + rectB.height) -
    Math.max(rectA.y, rectB.y);

  if (xOverlap > 0 && yOverlap > 0) {
    return { x: xOverlap, y: yOverlap };
  }

  return null;
}

interface ResolveCollisionsOptions {
  maxIterations?: number;
  overlapThreshold?: number;
  margin?: number;
}

/**
 * Resolves node collisions by iteratively pushing overlapping nodes apart.
 * Returns position changes for nodes that need to be moved.
 */
export function resolveCollisions(
  nodes: Node[],
  options: ResolveCollisionsOptions = {},
): NodeChange[] {
  const { maxIterations = 10, overlapThreshold = 1, margin = 20 } = options;

  // Create a map to track position changes
  const positionChanges = new Map<string, XYPosition>();

  // Initialize positions from current node positions
  for (const node of nodes) {
    positionChanges.set(node.id, { ...node.position });
  }

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let hasCollision = false;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeA = nodes[i];
        const nodeB = nodes[j];

        const posA = positionChanges.get(nodeA.id);
        const posB = positionChanges.get(nodeB.id);

        if (!posA || !posB) continue;

        const rectA: Rect = {
          x: posA.x,
          y: posA.y,
          width: (nodeA.measured?.width ?? 180) + margin,
          height: (nodeA.measured?.height ?? 80) + margin,
        };

        const rectB: Rect = {
          x: posB.x,
          y: posB.y,
          width: (nodeB.measured?.width ?? 180) + margin,
          height: (nodeB.measured?.height ?? 80) + margin,
        };

        const overlap = getOverlap(rectA, rectB);

        if (
          overlap &&
          (overlap.x > overlapThreshold || overlap.y > overlapThreshold)
        ) {
          hasCollision = true;

          // Determine which axis has less overlap to resolve
          if (overlap.x < overlap.y) {
            // Move horizontally
            const shift = overlap.x / 2;
            if (posA.x < posB.x) {
              posA.x -= shift;
              posB.x += shift;
            } else {
              posA.x += shift;
              posB.x -= shift;
            }
          } else {
            // Move vertically
            const shift = overlap.y / 2;
            if (posA.y < posB.y) {
              posA.y -= shift;
              posB.y += shift;
            } else {
              posA.y += shift;
              posB.y -= shift;
            }
          }

          positionChanges.set(nodeA.id, posA);
          positionChanges.set(nodeB.id, posB);
        }
      }
    }

    // If no collisions found, we're done
    if (!hasCollision) {
      break;
    }
  }

  // Generate changes for nodes that moved
  const changes: NodeChange[] = [];

  for (const node of nodes) {
    const newPos = positionChanges.get(node.id);
    if (!newPos) continue;

    const deltaX = Math.abs(newPos.x - node.position.x);
    const deltaY = Math.abs(newPos.y - node.position.y);

    // Only create change if position actually changed
    if (deltaX > 0.1 || deltaY > 0.1) {
      changes.push({
        id: node.id,
        type: "position",
        position: newPos,
      });
    }
  }

  return changes;
}
