import type { ToolDefinition } from "./types.ts";

export type ToolUseContext = {
  cwd: string;
};

export type Tool = ToolDefinition & {
  call(input: Record<string, unknown>, context: ToolUseContext): Promise<string>;
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
};
