import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolUseContext } from "../Tool.ts";
import { evaluateBashPermission } from "./BashTool/bashSafety.ts";

const execAsync = promisify(exec);

export const BashTool: Tool = {
  name: "bash",
  description: "Run a shell command in the current workspace.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" },
    },
    required: ["command"],
  },
  /**
   * 声明 bash 工具默认不参与并发执行，避免多个 shell 命令同时产生副作用。
   * @returns 始终返回 false，表示不可并发。
   */
  isConcurrencySafe() {
    return false;
  },
  /**
   * 在执行 bash 命令前进行工具级权限和风险分类。
   * @param input 模型提供的 bash 工具输入。
   * @param context 工具运行上下文，主要使用 cwd 做路径边界检查。
   * @returns bash 命令对应的权限判断结果。
   */
  checkPermissions(input: Record<string, unknown>, context: ToolUseContext) {
    //L01-S24 拦截危险命令（已演进）：第一课的内联危险命令判断迁移到 Lesson 03 的权限模块，保留编号说明这条学习路径没有被抹掉。
    //L03-S13 暴露工具级权限检查：BashTool 像 Claude Code 工具一样先声明自己的风险判断，再由统一 permission 层决定 ask/deny/allow。
    return evaluateBashPermission(input, context);
  },
  /**
   * 在当前工作目录中执行已经通过权限检查的 shell 命令。
   * @param input 模型提供的 bash 工具输入。
   * @param context 工具运行上下文，提供命令执行的 cwd。
   * @returns shell stdout/stderr 合并后的截断文本，或错误文本。
   */
  async call(input: Record<string, unknown>, context: ToolUseContext): Promise<string> {
    //L01-S25 执行具体工具：具体工具只接收 tool input 和 ToolUseContext，不接触 queryLoop 的消息状态。
    const command = String(input.command ?? "");
    if (!command.trim()) {
      return "Error: empty command";
    }

    try {
      const result = await execAsync(command, {
        cwd: context.cwd,
        timeout: 10_000,
        windowsHide: true,
      });
      const output = `${result.stdout}${result.stderr}`.trim();
      return output ? output.slice(0, 20_000) : "(no output)";
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
