import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

type LoadDotEnvOptions = {
  path?: string;
  override?: boolean;
};

/**
 * 加载本地 .env 文件，并把其中的键值写入当前进程环境变量。
 * @param options .env 路径和是否覆盖已有环境变量的配置。
 * @returns 成功加载时返回解析到的 .env 绝对路径；文件不存在时返回 null。
 */
export function loadDotEnv(options: LoadDotEnvOptions = {}): string | null {
  //L02-S08 加载本地配置：交互式应用启动时先读 .env，让 base url、api key、model 不需要写进命令行或源码。
  const envPath = resolve(options.path ?? ".env");
  if (!existsSync(envPath)) return null;

  const override = options.override ?? true;
  const parsed = parseEnv(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = value;
  }

  return envPath;
}
