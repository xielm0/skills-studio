import { useEffect, useState } from 'react';
import type { CliSetupStatus } from '../../../backend/src/shared/ipc';
import { CloseIcon } from './icons';
import { request } from '../ipc/client';
import c from '../styles/common.module.css';
import s from './CliSetupCard.module.css';

/**
 * 主页 CLI 接入卡片（照竞品 AgentControlSetupCard 的一次性指引）：
 * skills-studio skill 未入库时显示；勾选 Agent（默认全不选，不做一键全量部署），
 * 确认后从内置源入库并逐个同步；接入或关闭后永久消失（app-state.json 本机持久）。
 */
export function CliSetupCard() {
  const [status, setStatus] = useState<CliSetupStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void request('cliSetup:status').then((res) => {
      if (alive && res.ok) setStatus(res.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (status == null || status.card !== 'undecided' || status.installed || !status.sourceAvailable) return null;

  const candidates = status.agents.filter((a) => a.installed && a.enabled);

  const dismiss = async () => {
    setStatus(status == null ? null : { ...status, card: 'dismissed' });
    await request('cliSetup:dismiss');
  };

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((k) => k !== id) : [...current, id]));

  const confirm = async () => {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError(null);
    const res = await request('cliSetup:install', { agentIds: selected });
    if (res.ok) {
      setStatus(status == null ? null : { ...status, card: 'installed' });
    } else {
      setError(res.error.detail ?? res.error.code);
      setBusy(false);
    }
  };

  return (
    <div className={s.card} data-testid="cli-setup-card">
      <div className={s.body}>
        <h3 className={s.title}>CLI 接入</h3>
        <p className={s.description}>
          把 skills-studio 技能装入中心库并同步到勾选的 Agent，Agent 在对话里即可经 CLI 管理技能库。
        </p>

        {expanded && (
          <div className={s.picker}>
            <p className={s.pickerLabel}>同步到</p>
            <div className={s.chips}>
              {candidates.map((agent) => {
                const on = selected.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggle(agent.id)}
                    disabled={busy}
                    data-testid={`cli-setup-agent-${agent.id}`}
                    className={on ? s.chipOn : s.chip}
                  >
                    {agent.name}
                  </button>
                );
              })}
              {candidates.length === 0 && <span className={s.empty}>未检测到可用的 Agent 目录</span>}
            </div>
          </div>
        )}
        {error != null && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </div>

      <div className={s.actions}>
        {expanded ? (
          <button
            type="button"
            className={`${c.btn} ${c.btnPrimary}`}
            disabled={busy || selected.length === 0}
            onClick={() => void confirm()}
            data-testid="cli-setup-confirm"
          >
            {selected.length === 0 ? '先勾选 Agent' : <span className={s.confirmLabel}>{`接入（${selected.length}）`}</span>}
          </button>
        ) : (
          <button
            type="button"
            className={`${c.btn} ${c.btnGhost}`}
            onClick={() => setExpanded(true)}
            data-testid="cli-setup-expand"
          >
            接入
          </button>
        )}
        <button
          type="button"
          className={s.close}
          onClick={() => void dismiss()}
          title="不再显示"
          data-testid="cli-setup-dismiss"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
