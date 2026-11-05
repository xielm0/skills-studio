/**
 * T06：受限工具与授权目录边界（prd.md §6.1、tec.md §3 结构性约束 3、§8、用例 C-25）。
 *
 * 规则：
 *  - 会话运行时的工具白名单只有读/写类文件工具，**不含 bash / powershell**（无法用 shell 逃逸）；
 *  - 所有路径参数解析后必须落在授权目录内；
 *  - 符号链接 / 目录联接（junction）逃逸用 realpath 复检，防止「目录内链到目录外」；
 *  - 越界由 Pi 的 `tool_call` 事件层拦截（block + terminate），本次运行随之中止并返回
 *    `TOOL_OUT_OF_SCOPE`，而不是仅记录一条日志。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 允许的工具（Pi 内置名）。写类工具只影响授权目录内文件。 */
export const ALLOWED_TOOLS = ['read', 'write', 'edit', 'ls', 'grep', 'find'] as const;

/** 写类工具：只能落在授权目录内。其余白名单工具按只读处理。 */
const WRITE_TOOLS: readonly string[] = ['write', 'edit'];

/** 需要校验的路径参数名（各内置工具统一为 path，grep/find/ls 可省略 → 视为 cwd）。 */
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
  /** 规范化后的绝对路径（未提供路径参数时 = 授权目录） */
  resolvedPath: string;
}

export type ScopeCheck = ScopeAllowed | ScopeViolation;

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** 大小写不敏感的包含判定（Windows 文件系统语义）。 */
function isInside(base: string, target: string): boolean {
  const b = isWindows() ? base.toLowerCase() : base;
  const t = isWindows() ? target.toLowerCase() : target;
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * 取「真实路径」：对存在的目标用 realpath；不存在时向上找到最近的存在祖先再拼回剩余段。
 * 用于识别符号链接 / junction 逃逸。
 */
export function realResolve(target: string): string {
  const resolved = path.resolve(target);
  const suffix: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 授权目录守卫。一个实例绑定一次运行的授权目录。
 *
 * `readOnlyRoots` 是额外只读根（产品自带的内置 skill 目录）：读类工具可以访问，
 * write / edit 仍然只能落在授权目录内。
 */
export class ToolScopeGuard {
  /** 授权目录（规范化绝对路径） */
  readonly authorizedDir: string;
  /** 授权目录的真实路径（realpath，用于链接逃逸复检） */
  readonly realAuthorizedDir: string;
  /** 本次允许的工具集合 */
  readonly allowedTools: readonly string[];
  /** 额外只读根（规范化绝对路径 + 真实路径） */
  readonly readOnlyRoots: readonly { dir: string; realDir: string }[];

  constructor(
    authorizedDir: string,
    options: { readOnlyRoots?: readonly string[] } = {},
  ) {
    if (typeof authorizedDir !== 'string' || authorizedDir.trim().length === 0) {
      throw new Error('authorizedDir 不能为空');
    }
    this.authorizedDir = path.resolve(authorizedDir);
    this.realAuthorizedDir = realResolve(this.authorizedDir);
    this.allowedTools = ALLOWED_TOOLS;
    this.readOnlyRoots = (options.readOnlyRoots ?? []).map((dir) => {
      const resolved = path.resolve(dir);
      return { dir: resolved, realDir: realResolve(resolved) };
    });
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
      // 未提供路径 = 工具默认使用 cwd = 授权目录
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

    // 写类工具只认授权目录；读类工具还可以读额外只读根
    const roots = WRITE_TOOLS.includes(toolName)
      ? [{ dir: this.authorizedDir, realDir: this.realAuthorizedDir }]
      : [{ dir: this.authorizedDir, realDir: this.realAuthorizedDir }, ...this.readOnlyRoots];

    const inRoot = roots.find((root) => isInside(root.dir, resolved));
    if (!inRoot) {
      return {
        ok: false,
        code: 'TOOL_OUT_OF_SCOPE',
        toolName,
        requestedPath: requested,
        reason: `路径越出授权目录：${requested}`,
      };
    }

    // 链接逃逸复检：目录内 junction/symlink 指向目录外时，真实路径会越界
    const real = realResolve(resolved);
    if (!isInside(inRoot.realDir, real)) {
      return {
        ok: false,
        code: 'TOOL_OUT_OF_SCOPE',
        toolName,
        requestedPath: requested,
        reason: `路径经符号链接/junction 逃出授权目录：${requested}`,
      };
    }

    return { ok: true, toolName, resolvedPath: resolved };
  }

  /** 相对授权目录的展示路径（'.' 表示根）。 */
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
