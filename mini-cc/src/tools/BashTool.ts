import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolUseContext } from "../Tool.ts";

const execAsync = promisify(exec);

function isDangerous(command: string): boolean {
  //L01-S24 拦截危险命令：BashTool 先放最小危险命令拦截，后续 Permission 课程会把安全边界独立成模块。
  const dangerousPatterns = [
    "rm -rf /",
    "sudo ",
    "shutdown",
    "reboot",
    "> /dev/",
    "format ",
  ];
  return dangerousPatterns.some((pattern) => command.toLowerCase().includes(pattern));
}

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
  async call(input: Record<string, unknown>, context: ToolUseContext): Promise<string> {
    //L01-S25 执行具体工具：具体工具只接收 tool input 和 ToolUseContext，不接触 queryLoop 的消息状态。
    const command = String(input.command ?? "");
    if (!command.trim()) {
      return "Error: empty command";
    }
    if (isDangerous(command)) {
      return "Error: dangerous command blocked";
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
