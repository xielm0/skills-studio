import { useEffect, useState } from 'react';
import type { AppInfoResult } from '../../../backend/src/shared/ipc';
import { fetchAppInfo } from './client';

let cached: Promise<AppInfoResult | null> | null = null;

/** 应用元信息（版本 / 环境 / 库路径）：外壳唯一一次 IPC 读取，页面共享。 */
export function useAppInfo(): { info: AppInfoResult | null; failed: boolean } {
  const [info, setInfo] = useState<AppInfoResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    cached ??= fetchAppInfo();
    let alive = true;
    void cached.then((value) => {
      if (!alive) return;
      setInfo(value);
      setFailed(value === null);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { info, failed };
}
