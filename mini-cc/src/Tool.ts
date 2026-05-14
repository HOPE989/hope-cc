import type { ToolDefinition } from "./types.ts";

//L01-S08 定义工具上下文：ToolUseContext 是工具运行边界，第一课只保留 cwd，后续课程会继续加入权限和会话状态。
export type ToolUseContext = {
  cwd: string;
};

//L01-S09 定义工具协议：Tool 把 schema 暴露给模型，把 call 暴露给 harness，避免 queryLoop 直接依赖具体工具实现。
// 工具协议里还包含了 isConcurrencySafe 方法，后续课程会在并发执行工具时使用它来判断是否可以安全地并行调用工具。
export type Tool = ToolDefinition & {
  call(input: Record<string, unknown>, context: ToolUseContext): Promise<string>;
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
};
