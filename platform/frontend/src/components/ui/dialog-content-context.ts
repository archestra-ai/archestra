"use client";

import { createContext } from "react";

/**
 * True inside modal dialog content (`DialogContent`, `SheetContent`), so
 * portaled popovers know to keep their wheel and touch scrolling from reaching
 * the dialog's document-level scroll lock.
 */
export const DialogContentContext = createContext(false);
