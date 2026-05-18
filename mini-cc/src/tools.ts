import type { Tool } from "./Tool.ts";
import { BashTool } from "./tools/BashTool.ts";

/**
 * 集中返回 mini-cc 默认暴露给模型的工具列表。
 * @returns 当前默认启用的工具集合。
 */
export function getDefaultTools(): Tool[] {
  //L01-S10 注册默认工具：集中注册默认工具，后续 Tool Dispatcher 课程会在这里扩展 read/write/edit 等工具。
  return [BashTool];
}
