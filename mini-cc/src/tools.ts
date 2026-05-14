import type { Tool } from "./Tool.ts";
import { BashTool } from "./tools/BashTool.ts";

export function getDefaultTools(): Tool[] {
  //L01-S10 注册默认工具：集中注册默认工具，后续 Tool Dispatcher 课程会在这里扩展 read/write/edit 等工具。
  return [BashTool];
}
