/**
 * T06：Windows 凭据管理器薄封装（tec.md §2 凭据、§6.2 本机数据）。
 *
 * 目的：API Key 只存系统凭据管理器，**绝不落配置文件、日志、备份**。
 * 实现：PowerShell + P/Invoke advapi32 的 CredWriteW / CredReadW / CredDeleteW，
 * 不引入任何原生 npm 模块（项目硬约束）。
 *
 * 隔离纪律：target 名由调用方给定（生产 `skills-platform/provider/<id>`，
 * 测试 `skills-platform-test/...`），本模块不自行拼装业务键名。
 */
import { spawnSync } from 'node:child_process';

export class CredentialError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CredentialError';
  }
}

/** 凭据后端接口（便于测试替换；生产实现 = Windows 凭据管理器）。 */
export interface CredentialBackend {
  /** 后端标识，写进诊断信息（不含密钥） */
  readonly backend: string;
  set(target: string, secret: string, userName?: string): void;
  get(target: string): string | null;
  /** 返回 deleted / missing；不存在不视为错误 */
  delete(target: string): 'deleted' | 'missing';
}

/**
 * PowerShell 脚本：读取 stdin 的 JSON（{op,target,secret,user}），输出 {ok,value}。
 * CREDENTIAL 结构按 wincred.h 布局；Type=1（GENERIC），Persist=2（LOCAL_MACHINE）。
 * 密钥经 stdin 传入，不出现在命令行与进程参数中。
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$op = $payload.op
$target = $payload.target

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SkillsPlatformCredMan {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL cred, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);

    public static string Write(string target, string secret, string userName) {
        byte[] blob = Encoding.Unicode.GetBytes(secret);
        IntPtr blobPtr = Marshal.AllocHGlobal(blob.Length);
        IntPtr namePtr = Marshal.StringToHGlobalUni(target);
        IntPtr userPtr = Marshal.StringToHGlobalUni(userName);
        try {
            Marshal.Copy(blob, 0, blobPtr, blob.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = 1;
            cred.TargetName = namePtr;
            cred.CredentialBlob = blobPtr;
            cred.CredentialBlobSize = (uint)blob.Length;
            cred.Persist = 2;
            cred.UserName = userPtr;
            if (!CredWrite(ref cred, 0)) {
                throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
            }
            return "ok";
        } finally {
            Marshal.FreeHGlobal(blobPtr);
            Marshal.FreeHGlobal(namePtr);
            Marshal.FreeHGlobal(userPtr);
        }
    }

    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) { return null; }
            throw new Exception("CredRead failed: " + err);
        }
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] blob = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
            return Encoding.Unicode.GetString(blob);
        } finally {
            CredFree(ptr);
        }
    }

    public static string Delete(string target) {
        if (!CredDelete(target, 1, 0)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) { return "missing"; }
            throw new Exception("CredDelete failed: " + err);
        }
        return "deleted";
    }
}
'@

Add-Type -TypeDefinition $src -Language CSharp

try {
  switch ($op) {
    'set' { $r = [SkillsPlatformCredMan]::Write($target, $payload.secret, $(if ($payload.user) { $payload.user } else { 'skills-platform' })) }
    'get' { $r = [SkillsPlatformCredMan]::Read($target) }
    'delete' { $r = [SkillsPlatformCredMan]::Delete($target) }
    default { throw "unknown op: $op" }
  }
  $out = @{ ok = $true; value = $r } | ConvertTo-Json -Compress
} catch {
  $out = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
[Console]::Out.Write($out)
`;

const PS_SCRIPT_B64 = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

export interface WindowsCredentialOptions {
  /** PowerShell 可执行文件（默认 powershell.exe；测试可注入） */
  powershellPath?: string;
  /** 单次调用超时（默认 30s） */
  timeoutMs?: number;
  /** 读取缓存 TTL（默认 15s；避免每次模型请求都启动 PowerShell） */
  cacheTtlMs?: number;
  /** 允许非 Windows 平台（仅测试用；默认拒绝） */
  allowNonWindows?: boolean;
}

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

/**
 * Windows 凭据管理器实现。
 *
 * 读缓存：Pi 的每次模型请求都会解析一次凭据，PowerShell 启动成本约 0.3~0.6s，
 * 故对 `get` 结果做短 TTL 内存缓存（默认 15s）；`set`/`delete` 立即失效。
 */
export class WindowsCredentialStore implements CredentialBackend {
  readonly backend = 'windows-credential-manager';
  private readonly cache = new Map<string, CacheEntry>();
  private readonly psPath: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;

  constructor(options: WindowsCredentialOptions = {}) {
    if (process.platform !== 'win32' && options.allowNonWindows !== true) {
      throw new CredentialError('CREDENTIAL_UNAVAILABLE', '当前平台不支持 Windows 凭据管理器');
    }
    this.psPath = options.powershellPath ?? 'powershell.exe';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 15_000;
  }

  set(target: string, secret: string, userName?: string): void {
    if (!target.trim()) throw new CredentialError('CREDENTIAL_INVALID_TARGET', '凭据键名不能为空');
    if (!secret) throw new CredentialError('CREDENTIAL_INVALID_SECRET', '凭据内容不能为空');
    this.invoke({ op: 'set', target, secret, user: userName });
    this.cache.delete(target);
  }

  get(target: string): string | null {
    const cached = this.cache.get(target);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.invoke({ op: 'get', target }).value ?? null;
    this.cache.set(target, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  delete(target: string): 'deleted' | 'missing' {
    const value = this.invoke({ op: 'delete', target }).value;
    this.cache.delete(target);
    return value === 'deleted' ? 'deleted' : 'missing';
  }

  /** 清空读取缓存（设置项变更、测试隔离时调用） */
  clearCache(): void {
    this.cache.clear();
  }

  private invoke(payload: Record<string, unknown>): { value: string | null } {
    const res = spawnSync(this.psPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      PS_SCRIPT_B64,
    ], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: this.timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new CredentialError(
          'CREDENTIAL_UNAVAILABLE',
          '未找到 powershell.exe，无法访问 Windows 凭据管理器',
        );
      }
      throw new CredentialError('CREDENTIAL_ACCESS_FAILED', `调用 PowerShell 失败：${res.error.message}`);
    }
    if (res.status !== 0) {
      const stderr = String(res.stderr ?? '').trim();
      throw new CredentialError(
        'CREDENTIAL_ACCESS_FAILED',
        `PowerShell 退出码 ${res.status}${stderr ? `：${stderr.slice(0, 300)}` : ''}`,
      );
    }

    const raw = String(res.stdout ?? '').trim();
    if (!raw) throw new CredentialError('CREDENTIAL_ACCESS_FAILED', '凭据管理器返回空结果');
    let parsed: { ok?: boolean; value?: string | null; error?: string };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new CredentialError('CREDENTIAL_ACCESS_FAILED', '凭据管理器返回非 JSON 结果');
    }
    if (parsed.ok !== true) {
      throw new CredentialError('CREDENTIAL_ACCESS_FAILED', parsed.error ?? '凭据管理器操作失败');
    }
    return { value: parsed.value ?? null };
  }
}
