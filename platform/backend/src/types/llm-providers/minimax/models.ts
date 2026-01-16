/**
 * MiniMax Model Types
 *
 * MiniMax model definitions.
 * Models: MiniMax-M2, MiniMax-M2.1
 */
import { z } from "zod";

export const ModelSchema = z
  .string()
  .describe("MiniMax model identifier (e.g., MiniMax-M2, MiniMax-M2.1)");

export const OrlandoModelSchema = z
  .string()
  .describe("MiniMax model identifier for Orlando compatibility");
