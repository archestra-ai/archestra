"use client";

import { ToolContent, type ToolContentProps } from "./tool-content";
import {
  ToolErrorDetails,
  type ToolErrorDetailsProps,
} from "./tool-error-details";
import { ToolHeader, type ToolHeaderProps } from "./tool-header";
import { ToolInput, type ToolInputProps } from "./tool-input";
import { ToolOutput, type ToolOutputProps } from "./tool-output";
import { Tool as RootTool, type ToolProps } from "./tool";

export type {
  ToolContentProps,
  ToolErrorDetailsProps,
  ToolHeaderProps,
  ToolInputProps,
  ToolOutputProps,
  ToolProps,
};

export const Tool = Object.assign(RootTool, {
  Content: ToolContent,
  ErrorDetails: ToolErrorDetails,
  Header: ToolHeader,
  Input: ToolInput,
  Output: ToolOutput,
});
