import { useEffect, useState } from 'react';
import type { LibraryOverview, RecentActivityItem } from '../../../backend/src/shared/ipc';
import { CliSetupCard } from '../components/CliSetupCard';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { request } from '../ipc/client';
import { navigateSkill } from '../router';
import c from '../styles/common.module.css';
import s from './HomePage.module.css';

/**
 * 主页（ui.md「主页」）：库规模 / 同步覆盖 / 已接入 Agent 三张概览卡 + 近期动态。
 * 动态每技能只显示最新一条，点击整行进入该 Skill 的技能详情（T11 详情页）。
 * 查看与评测不产生动态（事件只在入库/内容变更/部署状态变化时写入）。
 */
export function HomePage() {
  const [overview, setOverview] = useState<LibraryOverview | null>(null);
  const [activity, setActivity] = useState<RecentActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([request('library:getOverview'), request('library:getRecentActivity')]).then(
      ([overviewResult, activityResult]) => {
        if (!alive) return;
        if (overviewResult.ok) setOverview(overviewResult.data);
        else setFailed(true);
        if (activityResult.ok) setActivity(activityResult.data.items);
        else setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const skillCount = overview?.skillCount ?? null;
  const connected = overview?.agentsConnected ?? null;
  const coverage = overview?.syncCoverage ?? null;

  /** 副标题只在加载/失败时承载状态；正常态由三张概览卡自己说清楚（ui.md「界面文案·页头」） */
  const subtitle = failed ? '无法读取中心库数据' : skillCount == null ? '正在读取…' : undefined;

  return (
    <section className={`${c.page} ${c.boundedPage}`}>
      <PageHeader title="主页" subtitle={subtitle} />

      <div className={c.content}>
        <div className={c.stats}>
          <div className={c.statCard}>
            <p className={c.statLabel}>库中 Skills</p>
            <p className={c.statValue} data-testid="home-skill-count">
              {skillCount == null ? '—' : skillCount}
            </p>
          </div>
          <div className={c.statCard}>
            <p className={c.statLabel}>同步覆盖</p>
            <p className={c.statValue} data-testid="home-coverage">
              {coverage == null ? '— / —' : `${coverage.deployed} / ${coverage.total}`}
            </p>
          </div>
          <div className={c.statCard}>
            <p className={c.statLabel}>已接入 Agents</p>
            <p className={c.statValue} data-testid="home-agents">
              {connected == null ? '—' : connected}
            </p>
          </div>
        </div>

        {/* CLI 接入卡片：独立区块，与概览卡/近期动态保持同一垂直节奏（.section 的 s-6） */}
        <div className={c.section}>
          <CliSetupCard />
        </div>

        <section className={c.section}>
          <div className={c.sectionHeader}>
            <h2 className={c.sectionTitle}>近期动态</h2>
          </div>

          {activity == null ? (
            <div className={c.emptyBox}>
              <EmptyState title={failed ? '无法读取近期动态' : '正在读取…'} />
            </div>
          ) : activity.length === 0 ? (
            <div className={c.emptyBox}>
              <EmptyState title={skillCount === 0 ? '中心库还没有 Skills' : '暂无近期动态'} />
            </div>
          ) : (
            <ul className={s.activityList} data-testid="home-activity">
              {activity.map((item) => (
                <li key={item.skillId}>
                  <button
                    type="button"
                    className={s.activityRow}
                    onClick={() => navigateSkill(item.skillId)}
                    title={`打开 ${item.name} 的技能详情`}
                  >
                    <span className={s.activityName}>{item.name}</span>
                    <span className={s.activityText}>
                      {item.text}
                      {item.missing ? ' · 目录已丢失' : ''}
                    </span>
                    <time className={s.activityTime} dateTime={item.occurredAt}>
                      {item.relativeTime}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
