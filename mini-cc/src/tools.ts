import type { Tool } from "./Tool.ts";
import { BashTool } from "./tools/BashTool.ts";

export function getDefaultTools(): Tool[] {
  return [BashTool];
}
