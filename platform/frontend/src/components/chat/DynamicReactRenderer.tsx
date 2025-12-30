"use client";

import React from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';

// A registry of components that can be dynamically rendered
// Add more components here as needed, by importing them.
const componentRegistry: Record<string, React.ElementType> = {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Badge,
  Separator,
  // Common HTML elements
  div: "div",
  p: "p",
  span: "span",
  ul: "ul",
  li: "li",
  h2: "h2",
  h3: "h3",
  strong: "strong",
};


interface DynamicReactRendererProps {
  componentName: string;
  props: Record<string, unknown>;
}

export function DynamicReactRenderer({ componentName, props }: DynamicReactRendererProps) {
  const Component = componentRegistry[componentName];

  if (!Component) {
    console.error(`Component '${componentName}' not found in registry.`);
    return <div className="text-destructive">Error: Component '{componentName}' not found.</div>;
  }

  const renderPropValue = (value: unknown, key?: React.Key): React.ReactNode => {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item, index) => renderPropValue(item, key !== undefined ? `${key}-${index}` : index));
    }

    // If it's an object that looks like a component descriptor
    if (typeof value === 'object' && value !== null && 'component' in value && typeof (value as { component: string }).component === 'string') {
      const componentData = value as { component: string; props?: Record<string, unknown> };
      return React.createElement(DynamicReactRenderer, {
        componentName: componentData.component,
        props: componentData.props || {},
        key,
      });
    }

    // If it's a generic object, stringify it
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }

    return null;
  };

  const processedProps: Record<string, unknown> = {};
  for (const key in props) {
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      processedProps[key] = renderPropValue(props[key], key);
    }
  }

  return React.createElement(Component, processedProps);
}

// Helper to deserialize and render the JSON representing the component tree
export function renderComponentTree(jsonTree: string): React.ReactNode {
  try {
    const data = JSON.parse(jsonTree);
    if (typeof data !== 'object' || data === null) {
        return <div className="text-destructive">Error: Invalid component tree data.</div>;
    }

    if (data.component && typeof data.component === 'string') {
        if (componentRegistry[data.component]) {
            return React.createElement(
                DynamicReactRenderer,
                { componentName: data.component, props: data.props || {} }
            );
        } else {
            // Component is defined but not in registry
            return <div className="text-destructive">Error: Component '{data.component}' not found.</div>;
        }
    } else if (Array.isArray(data)) {
        // If it's an array, try to render each item.
        return (
            <>
                {data.map((item, index) => {
                    // Each item in the array should ideally be a component descriptor or a primitive
                    if (typeof item === 'object' && item !== null && 'component' in item && typeof (item as { component: string }).component === 'string') {
                        if (componentRegistry[(item as { component: string }).component]) {
                            return React.createElement(
                                DynamicReactRenderer,
                                { componentName: (item as { component: string }).component, props: (item as { props: Record<string, unknown> }).props || {}, key: index }
                            );
                        } else {
                            return <div key={index} className="text-destructive">Error: Component '{(item as { component: string }).component}' not found in array.</div>;
                        }                     
                    } else if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
                        return <span key={index}>{item}</span>;
                    }
                    return <div key={index} className="text-destructive">Error: Invalid item in component tree array.</div>;
                })}
            </>
        );
    }
    return <div className="text-destructive">Error: Invalid component format.</div>;
  } catch (error) {
    console.error("Failed to parse component JSON:", error);
    return <div className="text-destructive">Error: Failed to load component.</div>;
  }
}
