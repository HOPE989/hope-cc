//L03-S06 定义权限结果协议：执行层进入 permission 合成后，需要一套结构化协议承接工具判断；mini-cc 保留 Claude Code 的 allow / ask / deny / passthrough 四态。
export type PermissionMode = "default" | "deny" | "bypass";

export type PermissionDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      reason?: string;
    }
  | {
      behavior: "ask";
      message: string;
      updatedInput?: Record<string, unknown>;
      reason?: string;
    }
  | {
      behavior: "deny";
      message: string;
      reason?: string;
    };

export type PermissionResult =
  | PermissionDecision
  | {
      behavior: "passthrough";
      message?: string;
      updatedInput?: Record<string, unknown>;
      reason?: string;
    };
