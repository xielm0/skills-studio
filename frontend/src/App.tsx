import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { useAppInfo } from './ipc/useAppInfo';
import { request } from './ipc/client';
import { navigate, useRoute, type Route } from './router';
import { AgentsPage } from './pages/AgentsPage';
import { BackupPage } from './pages/BackupPage';
import { ChatPage } from './pages/ChatPage';
import { FirstRunPage } from './pages/FirstRunPage';
import { HomePage } from './pages/HomePage';
import { InstallPage } from './pages/InstallPage';
import { LibraryPage } from './pages/LibraryPage';
import { SkillDetailPage } from './pages/SkillDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import type { AppInfoResult, InitialStateResult } from '../../backend/src/shared/ipc';
import s from './App.module.css';

function renderPage(route: Route, info: AppInfoResult | null, failed: boolean) {
  switch (route.id) {
    case 'home':
    case 'first-run':
      return <HomePage />;
    case 'library':
      return route.skillId
        ? <SkillDetailPage skillId={route.skillId} folder={route.query.get('folder') ?? undefined} />
        : <LibraryPage folder={route.query.get('folder') ?? ''} />;
    case 'install':
      return <InstallPage market={route.market} marketKey={route.query.get('key')} installPreview={route.installPreview} />;
    case 'backup':
      return <BackupPage />;
    case 'agents':
      return <AgentsPage initialAgent={route.query.get('agent')} />;
    case 'agent':
      return route.agentId && route.agentDir ? (
        <SkillDetailPage agent={{ agentId: route.agentId, dirName: route.agentDir }} />
      ) : (
        <AgentsPage />
      );
    case 'chat':
      return <ChatPage route={route} />;
    case 'settings':
      return <SettingsPage info={info} failed={failed} />;
    default:
      return <HomePage />;
  }
}

/**
 * 桌面外壳：左侧固定导航 + 主工作区（design.md「整体界面」）。
 * 首启优先：`app:getInitialState` 的 firstRunCompleted=false 时显示无侧栏的首次启动页；
 * 「从备份恢复」是首启内的唯一出口，导航到备份页（恢复流程属 T14）。
 */
export default function App() {
  const route = useRoute();
  const { info, failed } = useAppInfo();
  const [initial, setInitial] = useState<InitialStateResult | null>(null);
  const [initialFailed, setInitialFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void request('app:getInitialState').then((result) => {
      if (!alive) return;
      if (result.ok) setInitial(result.data);
      else setInitialFailed(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (initial == null) {
    return (
      <div className={s.loading}>
        <h1 className={s.loadingTitle}>正在启动 Skills 工作台…</h1>
        {initialFailed ? <p className={s.loadingHint}>无法读取应用状态：请通过 Electron 启动（npm start）。</p> : null}
      </div>
    );
  }

  const showFirstRun = !initial.firstRunCompleted && route.id !== 'backup';
  if (showFirstRun) {
    return (
      <FirstRunPage
        initialState={initial}
        onLibraryPathChange={(libraryPath) => setInitial({ ...initial, libraryPath })}
        onComplete={() => {
          setInitial({ ...initial, firstRunCompleted: true });
          navigate('home');
        }}
      />
    );
  }

  return (
    <div className={s.shell}>
      <Sidebar active={route.id} activeSessionId={route.id === 'chat' ? route.query.get('session') : null} libraryFolder={route.id === 'library' ? route.query.get('folder') : null} />
      <main className={s.workspace}>{renderPage(route, info, failed)}</main>
    </div>
  );
}
