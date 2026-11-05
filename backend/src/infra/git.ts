/**
 * 系统 git 薄封装（tec.md §2、§3.3、§7.3）。
 *
 * 约束（照搬竞品 `core/git_command.rs` 的取舍）：
 *  - 只用用户已安装的系统 git（子进程），不捆绑二进制、不引入 simple-git/nodegit 等封装；
 *  - `windowsHide: true`（不闪黑窗），继承用户既有 git 环境（凭据 helper / 代理 / SSH）；
 *  - 所有参数以数组传入（避免 shell 拼接注入），调用方不得把用户输入拼成一条命令；
 *  - 交互式提示一律关闭（`GIT_TERMINAL_PROMPT=0`）：凭据缺失时直接报错并保留现场，
 *    不让主进程挂在看不见的密码提示上；
 *  - stderr 进错误信息前必须脱敏（URL 内嵌 `user:token@`、常见 token 前缀）。
 *
 * 错误码语义（UI 据此给引导，tec.md §8）：
 *  GIT_NOT_INSTALLED / GIT_TIMEOUT / GIT_NETWORK_ERROR / GIT_AUTH_ERROR /
 *  GIT_PUSH_REJECTED / GIT_<OP>_FAILED
 */
import { spawnSync } from 'node:child_process';

export const GIT_DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    /** 已脱敏的 stderr（排障用，可安全落日志） */
    readonly diagnostic: string = '',
  ) {
    super(`${code}: ${detail}`);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  /** true = 非 0 退出码不抛错（用于探测类调用） */
  allowFailure?: boolean;
  input?: string | Buffer;
  /** 错误分类使用的操作名（默认取 args[0]） */
  operation?: string;
  env?: NodeJS.ProcessEnv;
}

export interface GitRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

let availability: boolean | null = null;

/** 是否检测到系统 git（结果缓存；入口处用于禁用备份功能并给安装引导）。 */
export function isGitInstalled(): boolean {
  if (availability != null) return availability;
  const res = spawnSync('git', ['--version'], { windowsHide: true, timeout: 15_000 });
  availability = !res.error && res.status === 0;
  return availability;
}

/** 测试用：清空可用性缓存（同一进程内切换环境时）。 */
export function resetGitAvailabilityCache(): void {
  availability = null;
}

export function assertGitInstalled(): void {
  if (!isGitInstalled()) {
    throw new GitError('GIT_NOT_INSTALLED', '未检测到系统 git，备份与同步不可用（请先安装 git）');
  }
}

/**
 * stderr 脱敏：`scheme://user:token@host` → `scheme://***@host`；
 * 常见 token 前缀与 Bearer 头一并抹掉。返回文本可落日志。
 */
export function redactGitOutput(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1***');
}

/** 按 stderr 归类错误（先判 Push 拒绝，再凭据，最后网络）。 */
export function classifyGitFailure(stderr: string, operation: string): string {
  if (
    /!\s*\[rejected\]|non-fast-forward|fetch first|Updates were rejected|failed to push some refs/i.test(stderr)
  ) {
    return 'GIT_PUSH_REJECTED';
  }
  if (
    /Authentication failed|Permission denied \(publickey\)|could not read Username|could not read Password|terminal prompts disabled|invalid username or password|Access denied|HTTP 403|403 Forbidden/i.test(
      stderr,
    )
  ) {
    return 'GIT_AUTH_ERROR';
  }
  if (
    /Could not resolve host|Connection (?:reset|refused|timed out|closed)|Failed to connect|SSL|TLS|cryptographic|timed out|RPC failed|Could not read from remote repository|network is unreachable/i.test(
      stderr,
    )
  ) {
    return 'GIT_NETWORK_ERROR';
  }
  return `GIT_${operation.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_FAILED`;
}

function operationOf(args: string[], explicit?: string): string {
  if (explicit) return explicit;
  // 跳过全局选项（-c / -C 等），取第一个子命令
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) continue;
    return args[i];
  }
  return 'git';
}

/**
 * 执行 git 子进程。成功返回 stdout/stderr；失败（且未 allowFailure）抛 GitError。
 * 绝不使用 shell，参数原样进 argv。
 */
export function runGit(args: string[], opts: GitRunOptions): GitRunResult {
  const operation = operationOf(args, opts.operation);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // 凭据缺失时直接报错，不弹交互提示（tec.md §7.3）
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...opts.env,
  };
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    windowsHide: true,
    timeout: opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: MAX_BUFFER,
    env,
  });

  if (res.error) {
    const errCode = (res.error as NodeJS.ErrnoException).code;
    if (errCode === 'ENOENT') {
      throw new GitError('GIT_NOT_INSTALLED', '未检测到系统 git，备份与同步不可用');
    }
    if (errCode === 'ETIMEDOUT') {
      throw new GitError(
        'GIT_TIMEOUT',
        `git ${operation} 超时（>${Math.round((opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS) / 1000)}s）`,
        redactGitOutput(String(res.stderr ?? '')),
      );
    }
    throw new GitError(`GIT_${operation.toUpperCase()}_FAILED`, `git 启动失败：${res.error.message}`);
  }

  const stdout = typeof res.stdout === 'string' ? res.stdout : String(res.stdout ?? '');
  const stderr = typeof res.stderr === 'string' ? res.stderr : String(res.stderr ?? '');
  const status = res.status ?? -1;

  if (status !== 0 && !opts.allowFailure) {
    const clean = redactGitOutput(stderr);
    const lastLine = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    throw new GitError(
      classifyGitFailure(stderr, operation),
      `git ${operation} 失败：${lastLine ?? `退出码 ${status}`}`,
      clean,
    );
  }
  return { status, stdout, stderr };
}

/** 执行 git 并要求成功，返回 trim 后的 stdout。 */
export function runGitOk(args: string[], opts: GitRunOptions): string {
  return runGit(args, opts).stdout.trim();
}

/** 执行 git 并返回二进制 stdout（`cat-file blob` 用）。 */
export function runGitBuffer(args: string[], opts: GitRunOptions): Buffer {
  const operation = operationOf(args, opts.operation);
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    windowsHide: true,
    timeout: opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...opts.env },
  });
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitError('GIT_NOT_INSTALLED', '未检测到系统 git，备份与同步不可用');
    }
    throw new GitError(`GIT_${operation.toUpperCase()}_FAILED`, `git 启动失败：${res.error.message}`);
  }
  if ((res.status ?? -1) !== 0) {
    const stderr = String(res.stderr ?? '');
    throw new GitError(
      classifyGitFailure(stderr, operation),
      `git ${operation} 失败`,
      redactGitOutput(stderr),
    );
  }
  return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? '');
}

/**
 * 远端地址校验（备份配置存 DATA_DIR，不落库；只存 URL，不存凭据）：
 *  - 拒绝空值、以 `-` 开头（防选项注入）、`ext::`（可执行任意命令）；
 *  - 拒绝 URL 内嵌凭据（`https://user:token@host`）——token 必须由系统凭据管理器提供；
 *  - 允许 https / ssh / ssh+scp 形式，以及本地路径（离线/测试用 bare 仓库）。
 */
export function validateRemoteUrl(raw: string): string {
  const url = raw.trim();
  if (!url) throw new GitError('GIT_INVALID_URL', 'Git 远端地址为空');
  if (url.startsWith('-')) throw new GitError('GIT_INVALID_URL', 'Git 远端地址不能以 "-" 开头');
  if (/^ext(-[a-z0-9]+)?::/i.test(url)) {
    throw new GitError('GIT_INVALID_URL', '不允许 ext:: 形式的 Git 传输地址');
  }
  if (/\/\/[^/\s@]+@/.test(url)) {
    throw new GitError('GIT_INVALID_URL', 'Git 远端地址不能包含凭据，token 请交给系统凭据管理器');
  }
  return url;
}
