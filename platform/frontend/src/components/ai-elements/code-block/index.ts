"use client";

import {
  CodeBlockCopyButton,
  type CodeBlockCopyButtonProps,
} from "./code-block-copy-button";
import { CodeBlock as RootCodeBlock, type CodeBlockProps } from "./code-block";

export type { CodeBlockCopyButtonProps, CodeBlockProps };

export const CodeBlock = Object.assign(RootCodeBlock, {
  CopyButton: CodeBlockCopyButton,
});
