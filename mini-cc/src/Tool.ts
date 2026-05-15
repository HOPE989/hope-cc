import type { ToolDefinition } from "./types.ts";
import type {
  PermissionMode,
  PermissionResult,
} from "./utils/permissions/PermissionResult.ts";

export type ToolPermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  message: string;
  reason?: string;
};

export type ToolPermissionContext = {
  mode: PermissionMode;
  //L03 回调函数，用于请求权限审批，返回一个 Promise，解析为用户是否批准工具使用。
  requestApproval?: (request: ToolPermissionRequest) => Promise<boolean>;
};

//L01-S08 定义工具上下文：ToolUseContext 是工具运行边界，第一课只保留 cwd，后续课程会继续加入权限和会话状态。
//L03-S03 扩展工具上下文：权限模式和 ask 回调由入口层放进 ToolUseContext，后续 QueryEngine 只负责把这份运行态能力传给 query loop。
export type ToolUseContext = {
  cwd: string;
  permissionContext?: ToolPermissionContext;
};

//L01-S09 定义工具协议：Tool 把 schema 暴露给模型，把 call 暴露给 harness，避免 queryLoop 直接依赖具体工具实现。
// 工具协议里还包含了 isConcurrencySafe 方法，后续课程会在并发执行工具时使用它来判断是否可以安全地并行调用工具。
export type Tool = ToolDefinition & {
  call(input: Record<string, unknown>, context: ToolUseContext): Promise<string>;
  //L03-S12 增加工具级权限钩子：具体工具先声明自己的输入风险，统一 permission 层再决定是否执行，避免把安全策略塞进 call()。
  checkPermissions?(
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult> | PermissionResult;
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
};
