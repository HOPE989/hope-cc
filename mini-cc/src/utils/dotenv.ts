import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

type LoadDotEnvOptions = {
  path?: string;
  override?: boolean;
};

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
