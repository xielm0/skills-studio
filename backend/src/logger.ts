import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Logger {
  info(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
}

/**
 * JSON Lines 日志：写入 LOG_DIR（= <DATA_DIR>/logs，gitignore），并镜像到 stdout 便于命令行验证。
 * 密钥脱敏规则由后续任务统一实现（tec.md §6.2），本阶段只建立结构。
 */
export function createLogger(dir?: string): Logger {
  const target = dir && dir.trim() ? dir : path.resolve(__dirname, '../logs');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `app-${new Date().toISOString().slice(0, 10)}.log`);

  const write = (level: 'info' | 'error', event: string, data?: unknown) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, data });
    fs.appendFileSync(file, line + '\n');
    process.stdout.write(line + '\n');
  };

  return {
    info: (event, data) => write('info', event, data),
    error: (event, data) => write('error', event, data),
  };
}
