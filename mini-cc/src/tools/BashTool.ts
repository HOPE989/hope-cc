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
  isConcurrencySafe() {
    return false;
  },
  checkPermissions(input: Record<string, unknown>, context: ToolUseContext) {
    //L01-S24 拦截危险命令（已演进）：第一课的内联危险命令判断迁移到 Lesson 03 的权限模块，保留编号说明这条学习路径没有被抹掉。
    //L03-S13 暴露工具级权限检查：BashTool 像 Claude Code 工具一样先声明自己的风险判断，再由统一 permission 层决定 ask/deny/allow。
    return evaluateBashPermission(input, context);
  },
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
