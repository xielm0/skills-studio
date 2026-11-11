/**
 * Git 浅克隆（tec.md §2/§7.3：依赖用户安装的系统 git，子进程调用、隐藏窗口；
 * 继承用户既有 git 环境与凭据；失败时返回结构化 code + detail，不弹交互式提示）。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceError } from '../domain/sources/types';

const CLONE_TIMEOUT_MS = 300_000;

/** git 命令参数放行的 URL 校验：拒绝以 '-' 开头（防选项注入）与 ext:: 传输（可执行任意命令）。 */
export function validateGitSource(url: string): void {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new SourceError('GIT_INVALID_URL', 'Git 地址为空');
  }
  if (trimmed.startsWith('-')) {
    throw new SourceError('GIT_INVALID_URL', 'Git 地址不能以 "-" 开头');
  }
  if (/^ext(-[a-z0-9]+)?::/i.test(trimmed)) {
    throw new SourceError('GIT_INVALID_URL', '不允许 ext:: 形式的 Git 传输地址');
  }
}

/** stderr 中的 URL 凭据脱敏（user:token@ 形式不进错误详情）。 */
function redact(text: string): string {
  return text.replace(/:\/\/[^\s@/]+@/g, '://***@');
}

/** 按 stderr 文本归类网络/凭据错误（给 UI 明确原因，tec.md §7.3 失败语义）。 */
function classify(stderr: string): string {
  if (
    /Could not resolve host|network|timed out|Connection (?:reset|refused|timed out|closed)|SSL|TLS|Failed to connect/i.test(
      stderr,
    )
  ) {
    return 'GIT_NETWORK_ERROR';
  }
  if (
    /Authentication failed|Permission denied|403|could not read Username|terminal prompts disabled|Access denied/i.test(
      stderr,
    )
  ) {
    return 'GIT_AUTH_ERROR';
  }
  return 'GIT_CLONE_FAILED';
}

/**
 * `git clone --depth 1` 到 destDir（目录须不存在）。失败抛 SourceError。
 * 本地 bare 仓库克隆时 --depth 被忽略属预期（warning 不影响退出码）。
 */
export function gitCloneShallow(url: string, destDir: string, opts?: { branch?: string }): void {
  const version = spawnSync('git', ['--version'], { windowsHide: true, timeout: 15_000 });
  if (version.error || version.status !== 0) {
    throw new SourceError('GIT_NOT_INSTALLED', '未检测到系统 git，无法从 Git 仓库导入');
  }

  const parent = path.dirname(destDir);
  fs.mkdirSync(parent, { recursive: true });

  const args = ['clone', '--depth', '1'];
  if (opts?.branch) args.push('--branch', opts.branch);
  args.push(url, destDir);

  const res = spawnSync('git', args, {
    windowsHide: true,
    timeout: CLONE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new SourceError('GIT_TIMEOUT', `git 克隆超时（>${CLONE_TIMEOUT_MS / 1000}s）`);
    }
    throw new SourceError('GIT_CLONE_FAILED', `git 启动失败：${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = redact(String(res.stderr ?? '').trim());
    const lines = stderr.split(/\r?\n/).filter(Boolean);
    // 优先取 git 的 fatal/error 行：最后一行可能是续行（如 “and the repository exists.”），单独展示不可读
    const lastLine =
      [...lines].reverse().find((line) => /^(fatal|error):/i.test(line)) ??
      lines.pop() ??
      `git 退出码 ${res.status}`;
    throw new SourceError(classify(stderr), `git 克隆失败：${lastLine}`);
  }
}

/** 后台更新检查使用异步 git，避免网络等待阻塞 Electron 主进程。 */
export function gitCloneShallowAsync(url: string, destDir: string, opts?: { branch?: string }): Promise<void> {
  validateGitSource(url);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  const args = ['clone', '--depth', '1'];
  if (opts?.branch) args.push('--branch', opts.branch);
  args.push(url, destDir);
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, CLONE_TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new SourceError(error.code === 'ENOENT' ? 'GIT_NOT_INSTALLED' : 'GIT_CLONE_FAILED',
        error.code === 'ENOENT' ? '未检测到系统 git，无法检查更新' : `git 启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new SourceError('GIT_TIMEOUT', `git 克隆超时（>${CLONE_TIMEOUT_MS / 1000}s）`));
      if (code === 0) return resolve();
      const safe = redact(stderr.trim());
      const lines = safe.split(/\r?\n/).filter(Boolean);
      const message = [...lines].reverse().find((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1) ?? `git 退出码 ${code}`;
      reject(new SourceError(classify(safe), `git 克隆失败：${message}`));
    });
  });
}

/** 记录浅克隆当前 HEAD；无法读取时不影响已发现的内容。 */
export function gitRevision(repoDir: string): string | undefined {
  const result = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const revision = result.status === 0 ? result.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/i.test(revision) ? revision : undefined;
}

/** gitRevision 的异步版（GUI 主进程专用：rev-parse 不在主进程同步等待）。 */
export function gitRevisionAsync(repoDir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      const revision = code === 0 ? out.trim() : '';
      resolve(/^[0-9a-f]{40,64}$/i.test(revision) ? revision : undefined);
    });
  });
}
