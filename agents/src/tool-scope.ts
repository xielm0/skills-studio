/**
 * T06：Pi 内置工具配置。会话目录仅作为相对路径和命令的工作目录。
 */
import * as path from 'node:path';

/** Pi 支持的全部内置工具。 */
export const ALLOWED_TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'find', 'bash', 'powershell'] as const;

/** 文件工具的路径参数；省略时以 cwd 为基准。 */
const PATH_ARG = 'path';

export interface ScopeViolation {
  ok: false;
  code: 'TOOL_OUT_OF_SCOPE';
  toolName: string;
  /** 模型请求的原始路径（脱敏后写入事件的摘要里） */
  requestedPath: string | null;
  reason: string;
}

export interface ScopeAllowed {
  ok: true;
  toolName: string;
  /** 规范化后的绝对路径（未提供路径参数时 = 工作目录） */
  resolvedPath: string;
}

export type ScopeCheck = ScopeAllowed | ScopeViolation;

/**
 * 工具检查器。保留会话目录作为 Pi 的 cwd 和展示路径基准。
 */
export class ToolScopeGuard {
  /** 工作目录（规范化绝对路径） */
  readonly authorizedDir: string;
  /** 本次允许的工具集合 */
  readonly allowedTools: readonly string[];
  constructor(authorizedDir: string) {
    if (typeof authorizedDir !== 'string' || authorizedDir.trim().length === 0) {
      throw new Error('authorizedDir 不能为空');
    }
    this.authorizedDir = path.resolve(authorizedDir);
    this.allowedTools = ALLOWED_TOOLS;
  }

  /** 工具白名单判定（不含路径参数的工具也会被这里拒绝）。 */
  isToolAllowed(toolName: string): boolean {
    return this.allowedTools.includes(toolName);
  }

  /** 校验一次工具调用；不修改任何状态。 */
  check(toolName: string, input: Record<string, unknown> | undefined | null): ScopeCheck {
    if (!this.isToolAllowed(toolName)) {
      return {
        ok: false,
        code: 'TOOL_OUT_OF_SCOPE',
        toolName,
        requestedPath: null,
        reason: `工具 ${toolName} 不在白名单内（允许：${this.allowedTools.join('/')}）`,
      };
    }

    const raw = input?.[PATH_ARG];
    if (raw === undefined || raw === null || raw === '') {
      // 未提供路径时使用 cwd
      return { ok: true, toolName, resolvedPath: this.authorizedDir };
    }
    if (typeof raw !== 'string') {
      return {
        ok: false,
        code: 'TOOL_OUT_OF_SCOPE',
        toolName,
        requestedPath: null,
        reason: '路径参数类型非法（必须是字符串）',
      };
    }

    const requested = raw.trim();
    const resolved = path.resolve(this.authorizedDir, requested);

    return { ok: true, toolName, resolvedPath: resolved };
  }

  /** 相对工作目录的展示路径（'.' 表示根）。 */
  relativize(target: string): string {
    const rel = path.relative(this.authorizedDir, path.resolve(target));
    return rel === '' ? '.' : rel.split(path.sep).join('/');
  }

  /** 越界错误详情（写入事件与运行结果）。 */
  describeViolation(violation: ScopeViolation): string {
    return violation.requestedPath
      ? `${violation.reason}（工具：${violation.toolName}）`
      : violation.reason;
  }
}
