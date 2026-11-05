import { useEffect, useMemo, useState } from 'react';
import type {
  AgentsResult,
  AgentView,
  AppInfoResult,
  AppUpdateState,
  IpcError,
  ProviderView,
  ProvidersResult,
} from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { AgentIcon, ChevronDownIcon, EditIcon } from '../components/icons';
import { request } from '../ipc/client';
import { getAgentIconSrc } from '../utils/agent-icons';
import c from '../styles/common.module.css';
import { shortenHome } from '../utils/path';
import s from './SettingsPage.module.css';

/**
 * 协议类型：与 Pi 的 `api` 取值一一对应（多一个少一个都会配置出错）。
 * 协议由平台预设带入并锁定，只有「自定义（OpenAI 兼容）」允许手选——
 * 不同协议对应不同 Endpoint，放开手选会出现「OpenAI 地址 + Anthropic 协议」这类配错的组合。
 */
const API_FORMATS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

interface ProviderForm {
  preset: string;
  name: string;
  apiFormat: string;
  baseUrl: string;
  apiKey: string;
  /** 待保存的模型清单：一行一个模型 ID，空行在提交时丢弃 */
  models: string[];
}

function errorText(error: IpcError | undefined): string {
  if (!error) return '操作失败';
  return error.detail ?? error.code;
}

/**
 * 设置（ui.md「设置」）：
 *  - Agent：三列卡片（名称 / 开关 / 全局 Skills 目录 / 修改路径），支持新增、全部启用/禁用、重新检测；
 *  - 常规：中心库路径 + 更改目录（事务性迁移）+ 打开文件夹；
 *  - 模型配置：只列供应商，单选生效；新建供应商表单（平台预设/名称/协议类型/Endpoint/API Key）。
 */
export function SettingsPage({ info, failed }: { info: AppInfoResult | null; failed: boolean }) {
  const [agents, setAgents] = useState<AgentsResult | null>(null);
  const [providers, setProviders] = useState<ProvidersResult | null>(null);
  const [libraryPath, setLibraryPath] = useState<string | null>(info?.libraryDir ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notDetectedExpanded, setNotDetectedExpanded] = useState(false);
  /** 应用自更新状态：主进程推送为准（updates:state 只作首挂载兜底） */
  const [update, setUpdate] = useState<AppUpdateState | null>(null);

  const [modal, setModal] = useState<
    'add-agent' | 'edit-path' | 'provider' | 'remove-provider' | 'move' | null
  >(null);
  const [editAgentId, setEditAgentId] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState('');
  const [agentNameDraft, setAgentNameDraft] = useState('');
  /** 非空 → 供应商表单处于编辑态（平台预设锁定） */
  const [editProviderId, setEditProviderId] = useState<string | null>(null);
  /** 待确认删除的供应商 */
  const [removeTarget, setRemoveTarget] = useState<ProviderView | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  /** 目标非空 → 迁移确认弹层里改为「合并」策略 */
  const [moveNeedsPolicy, setMoveNeedsPolicy] = useState(false);
  const [form, setForm] = useState<ProviderForm>({
    preset: '',
    name: '',
    apiFormat: 'openai-completions',
    baseUrl: '',
    apiKey: '',
    models: [''],
  });
  /** 展开候选列表的行号（自绘下拉：原生 datalist 的字重改不动） */
  const [modelRowFocus, setModelRowFocus] = useState<number | null>(null);

  async function refresh() {
    const [agentsResult, providersResult, stateResult] = await Promise.all([
      request('agents:list'),
      request('providers:list'),
      request('app:getInitialState'),
    ]);
    if (agentsResult.ok) setAgents(agentsResult.data);
    else setError(errorText(agentsResult.error));
    if (providersResult.ok) setProviders(providersResult.data);
    else setError(errorText(providersResult.error));
    // 库路径以主进程实时值为准（app:info 是启动时快照，迁移后会过期）
    if (stateResult.ok) setLibraryPath(stateResult.data.libraryPath);
  }

  useEffect(() => {
    void refresh();
    // 更新状态：先拉一次快照，再订阅主进程推送（检查/下载/失败都从这里来）
    void request('updates:state').then((result) => {
      if (result.ok) setUpdate(result.data);
    });
    return window.skp?.onUpdateState(setUpdate);
  }, []);

  const stats = agents?.stats;
  const agentList = agents?.agents ?? [];
  /** 存在性由分组表达，卡片内不再重复状态文字（ui.md「界面文案 · 状态表达」） */
  const detectedAgents = agentList.filter((agent) => agent.installed);
  const notDetectedAgents = agentList.filter((agent) => !agent.installed);
  const providerList = providers?.providers ?? [];
  const activeProviderId = providers?.activeProviderId ?? null;
  const presets = providers?.presets ?? [];
  /** 某预设的候选模型（只作「模型」行的候选，不自动写入） */
  const suggestedModelsOf = (presetId: string): string[] =>
    presets.find((preset) => preset.preset === presetId)?.suggestedModels ?? [];
  /** 当前行的候选：按已输入内容过滤，最多 30 条 */
  const modelOptionsFor = (index: number): string[] => {
    const all = suggestedModelsOf(form.preset);
    const query = (form.models[index] ?? '').trim().toLowerCase();
    const matched = query ? all.filter((model) => model.toLowerCase().includes(query)) : all;
    return matched.slice(0, 30);
  };
  /** 编辑态取现有记录：只用于字段注（Key 是否已保存）与标题 */
  const editingProvider = providerList.find((provider) => provider.id === editProviderId) ?? null;

  const editAgent = useMemo(
    () => agentList.find((agent) => agent.id === editAgentId) ?? null,
    [agentList, editAgentId],
  );

  const versionLine = info
    ? `Skills 工作台 ${info.version}`
    : failed
      ? '版本信息不可用（IPC 未连接）'
      : null;

  /* ---- 应用自更新（unsupported = 开发/未配置发布源，不出现检查入口） ---- */
  const updateText = (() => {
    if (!update) return null;
    switch (update.status) {
      case 'checking':
        return '正在检查更新…';
      case 'up-to-date':
        return '已是最新版本';
      case 'downloading':
        return update.progress
          ? `正在下载新版本 v${update.availableVersion ?? ''} ${Math.round(update.progress.percent)}%`
          : '正在下载新版本…';
      case 'downloaded':
        return `新版本 v${update.availableVersion ?? ''} 已就绪，重启后完成更新`;
      case 'error':
        return `检查更新失败：${update.error ?? '未知原因'}`;
      default:
        return null;
    }
  })();
  const updateAction =
    update?.status === 'downloaded'
      ? { label: '重启并更新', run: () => void request('updates:install') }
      : update?.status === 'error'
        ? { label: '重试', run: checkUpdate }
        : update && update.status !== 'unsupported' && update.status !== 'downloading'
          ? { label: '检查更新', run: checkUpdate }
          : null;

  async function checkUpdate() {
    const result = await request('updates:check');
    if (result.ok) setUpdate(result.data);
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function toggleAgent(id: string, enabled: boolean) {
    await run(async () => {
      const result = await request('agents:setEnabled', { agentId: id, enabled });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setAgents(result.data);
    });
  }

  async function toggleAll(enabled: boolean) {
    await run(async () => {
      const result = await request('agents:setEnabled', { enabled });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setAgents(result.data);
      setNotice(enabled ? '已全部启用' : '已全部禁用（已同步的链接保留）');
    });
  }

  async function redetect() {
    await run(async () => {
      const result = await request('agents:redetect');
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setAgents(result.data);
      setNotice(`重新检测完成：已检测 ${result.data.stats.detected} 个 Agent`);
    });
  }

  async function pickInto(setter: (value: string) => void, title: string) {
    const picked = await request('app:pickDirectory', { title, defaultPath: pathDraft || libraryPath || undefined });
    if (!picked.ok) {
      setError(errorText(picked.error));
      return;
    }
    if (picked.data.path) setter(picked.data.path);
  }

  async function submitAddAgent() {
    await run(async () => {
      const result = await request('agents:addCustom', {
        name: agentNameDraft.trim(),
        skillsDir: pathDraft.trim(),
      });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setAgents(result.data);
      setModal(null);
      setNotice('已新增 Agent');
    });
  }

  async function submitEditPath() {
    if (!editAgent) return;
    await run(async () => {
      const result = await request('agents:updatePath', {
        agentId: editAgent.id,
        skillsDir: pathDraft.trim(),
      });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setAgents(result.data);
      setModal(null);
      setNotice(`已更新 ${editAgent.name} 的 Skills 目录`);
    });
  }

  /** 更改中心库目录：先按「空目录」尝试；目标非空时要求用户选择合并。 */
  async function changeLibrary() {
    const picked = await request('app:pickDirectory', {
      title: '选择中心技能库位置',
      defaultPath: libraryPath ?? undefined,
    });
    if (!picked.ok) {
      setError(errorText(picked.error));
      return;
    }
    const target = picked.data.path;
    if (!target) return;
    setMoveTarget(target);
    setMoveNeedsPolicy(false);
    setError(null);
    setModal('move');
  }

  async function confirmMove() {
    if (!moveTarget) return;
    await run(async () => {
      const result = await request('library:changeDirectory', {
        targetDir: moveTarget,
        policy: moveNeedsPolicy ? 'merge' : undefined,
      });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      const data = result.data;
      if (data.status === 'moved') {
        setLibraryPath(data.libraryPath);
        setModal(null);
        setNotice(
          `中心库已迁移到 ${data.libraryPath}，重建链接 ${data.links?.rebuilt ?? 0} 条${
            data.warning ? `（${data.warning}）` : ''
          }`,
        );
        return;
      }
      if (data.status === 'needs-policy') {
        setMoveNeedsPolicy(true);
        return;
      }
      setError(data.error ?? '更改目录失败');
    });
  }

  async function openFolder() {
    const result = await request('library:openFolder');
    if (!result.ok) setError(errorText(result.error));
    else if (!result.data.ok) setError(`打开文件夹失败：${result.data.error ?? '未知原因'}`);
  }

  function openProviderForm() {
    const first = presets[0];
    setEditProviderId(null);
    setForm({
      preset: first?.preset ?? '',
      name: first?.label ?? '',
      apiFormat: first?.apiFormat ?? 'openai-completions',
      baseUrl: first?.defaultBaseUrl ?? '',
      apiKey: '',
      models: [''],
    });
    setError(null);
    setModal('provider');
  }

  /** 编辑供应商：带回已有名称/协议/Endpoint/模型，平台预设锁定（预设即供应商身份）。 */
  function openProviderEdit(provider: ProviderView) {
    setEditProviderId(provider.id);
    setForm({
      preset: provider.preset,
      name: provider.name,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
      apiKey: '',
      models: provider.models.length > 0 ? [...provider.models] : [''],
    });
    setError(null);
    setModal('provider');
  }

  function applyPreset(presetId: string) {
    const preset = presets.find((p) => p.preset === presetId);
    if (!preset) return;
    setModelRowFocus(null);
    setForm((prev) => {
      const prevLabel = presets.find((p) => p.preset === prev.preset)?.label;
      const keepName = prev.name.trim().length > 0 && prev.name !== prevLabel;
      return {
        ...prev,
        preset: preset.preset,
        name: keepName ? prev.name : preset.label,
        apiFormat: preset.apiFormat,
        baseUrl: preset.defaultBaseUrl || prev.baseUrl,
        // 换厂商后原模型 ID 基本不适用（各家命名不同），一并清空避免配错
        models: prev.preset === preset.preset ? prev.models : [''],
      };
    });
  }

  /** 每行一个模型 ID：改哪行改哪行，空行提交时丢弃 */
  function updateFormModel(index: number, value: string) {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((model, i) => (i === index ? value : model)),
    }));
  }

  /** 「添加」= 追加一行空输入（不是把当前输入提交到配置） */
  function addFormModelRow() {
    setModelRowFocus(null);
    setForm((prev) => ({ ...prev, models: [...prev.models, ''] }));
  }

  function removeFormModel(index: number) {
    setModelRowFocus(null);
    setForm((prev) => ({
      ...prev,
      models: prev.models.length > 1 ? prev.models.filter((_, i) => i !== index) : [''],
    }));
  }

  async function submitProvider() {
    const apiKey = form.apiKey.trim();
    if (apiKey.length > 0 && apiKey.length < 6) {
      setError('API Key 至少 6 个字符；也可留空稍后再填写');
      return;
    }
    const editing = editProviderId !== null;
    // 空行丢弃；重复行只留第一条；非法字符（空白/引号）在提交前拦掉
    const models: string[] = [];
    for (const raw of form.models) {
      const model = raw.trim();
      if (!model) continue;
      if (/[\s"'`]/.test(model)) {
        setError(`模型 ID 不能包含空白或引号：${model}`);
        return;
      }
      if (!models.includes(model)) models.push(model);
    }
    await run(async () => {
      const result = await request('providers:add', {
        preset: form.preset,
        name: form.name.trim() || undefined,
        baseUrl: form.baseUrl.trim(),
        apiFormat: form.apiFormat,
        models,
        apiKey: apiKey ? form.apiKey : undefined,
      });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setProviders(result.data);
      setModal(null);
      setEditProviderId(null);
      setNotice(
        editing ? `已保存 ${form.name.trim()} 的修改` : `已创建供应商 ${form.name.trim()}`,
      );
    });
  }

  async function submitRemoveProvider() {
    if (!removeTarget) return;
    const providerId = removeTarget.id;
    const name = removeTarget.name;
    await run(async () => {
      const result = await request('providers:remove', { providerId });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setProviders(result.data);
      setModal(null);
      setRemoveTarget(null);
      setNotice(`已删除供应商 ${name}`);
    });
  }

  async function setActiveProvider(providerId: string) {
    await run(async () => {
      const result = await request('providers:setActive', { providerId });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setProviders(result.data);
    });
  }

  /** Agent 卡片：图标 + 名称 + 开关 / 全局 Skills 目录 + 编辑图标（ui.md「设置」卡片内容） */
  function renderAgentCard(agent: AgentView) {
    const iconSrc = getAgentIconSrc(agent.id, agent.name);
    return (
      <div key={agent.id} className={s.agentCard}>
        <div className={s.agentHead}>
          {iconSrc
            ? <img className={s.agentLogo} src={iconSrc} alt="" aria-hidden="true" />
            : <span className={s.agentMark} aria-hidden="true"><AgentIcon size={16} /></span>}
          <span className={s.agentName} title={agent.id}>
            {agent.name}
          </span>
          {agent.builtin ? null : <span className={s.agentTag}>自定义</span>}
          <button
            type="button"
            role="switch"
            aria-checked={agent.enabled}
            aria-label={`${agent.name} 启用开关`}
            className={`${s.switch} ${agent.enabled ? s.switchOn : ''}`}
            onClick={() => void toggleAgent(agent.id, !agent.enabled)}
            disabled={busy}
          >
            <span className={s.knob} />
          </button>
        </div>
        <div className={s.agentPathRow}>
          <p className={s.agentPath} title={agent.skillsDir}>
            {shortenHome(agent.skillsDir)}
          </p>
          <button
            type="button"
            className={s.agentEdit}
            title="修改路径"
            aria-label={`修改 ${agent.name} 的 Skills 目录`}
            onClick={() => {
              setEditAgentId(agent.id);
              setPathDraft(agent.skillsDir);
              setModal('edit-path');
            }}
          >
            <EditIcon size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className={`${c.page} ${c.boundedPage}`}>
      <PageHeader title="设置" />

      <div className={c.content}>
        {error ? <p className={s.errorBanner}>{error}</p> : null}
        {notice ? <p className={s.noticeBanner}>{notice}</p> : null}

        <section>
          <div className={s.sectionHeadRow}>
            <div>
              <h2 className={c.sectionTitle}>支持的 Agent</h2>
              <p className={s.sectionMeta}>
                已检测 <b>{stats?.detected ?? '—'}</b>
                <span className={s.metaSep}>·</span>已启用 <b>{stats?.enabled ?? '—'}</b>
                <span className={s.metaSep}>·</span>自定义 <b>{stats?.custom ?? '—'}</b>
              </p>
            </div>
            <div className={s.actions}>
              <button
                type="button"
                className={c.btn}
                onClick={() => {
                  setAgentNameDraft('');
                  setPathDraft('');
                  setModal('add-agent');
                }}
                data-testid="add-agent"
              >
                新增 Agent
              </button>
              <button type="button" className={c.btn} onClick={() => void toggleAll(true)} disabled={busy}>
                全部启用
              </button>
              <button type="button" className={c.btn} onClick={() => void toggleAll(false)} disabled={busy}>
                全部禁用
              </button>
              <button type="button" className={c.btn} onClick={() => void redetect()} disabled={busy}>
                重新检测
              </button>
            </div>
          </div>

          {agents == null ? (
            <div className={c.emptyBox}>
              <EmptyState title="正在读取 Agent 配置…" />
            </div>
          ) : (
            <>
              {detectedAgents.length > 0 ? (
                <div className={s.group}>
                  <div className={s.groupHead}>
                    <span className={s.groupTitle}>已检测到的 Agent</span>
                    <span className={s.groupCount}>{detectedAgents.length}</span>
                  </div>
                  <div className={s.agentGrid} data-testid="agent-cards">
                    {detectedAgents.map(renderAgentCard)}
                  </div>
                </div>
              ) : null}
              {notDetectedAgents.length > 0 ? (
                <div className={s.group}>
                  <div className={`${s.groupHead} ${notDetectedExpanded ? '' : s.groupHeadCollapsed}`}>
                    <button
                      type="button"
                      className={s.groupToggle}
                      aria-expanded={notDetectedExpanded}
                      aria-controls="not-detected-agent-cards"
                      onClick={() => setNotDetectedExpanded((expanded) => !expanded)}
                    >
                      <span className={s.groupTitle}>未检测到目录</span>
                      <span className={s.groupCount}>{notDetectedAgents.length}</span>
                      <span className={s.groupChevron} aria-hidden="true"><ChevronDownIcon size={14} /></span>
                    </button>
                  </div>
                  <div id="not-detected-agent-cards" className={s.agentGrid} hidden={!notDetectedExpanded}>
                    {notDetectedAgents.map(renderAgentCard)}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>

        <section className={c.section}>
          <div className={c.sectionHeader}>
            <h2 className={c.sectionTitle}>常规</h2>
          </div>
          <div className={c.card}>
            <div className={c.cardRow}>
              <div className={s.libraryLabel}>
                <p className={c.cardTitle}>中心技能库路径</p>
                <p className={c.cardDesc}>所有 Skills 的默认存放位置</p>
              </div>
              <div className={s.libraryControls}>
                <code className={s.libraryPath} title={libraryPath ?? undefined} data-testid="library-path">
                  {libraryPath ?? '读取中…'}
                </code>
                <button type="button" className={c.btn} onClick={() => void changeLibrary()} disabled={busy}>
                  更改目录
                </button>
                <button type="button" className={c.btn} onClick={() => void openFolder()}>
                  打开文件夹
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className={c.section}>
          <div className={s.sectionHeadLine}>
            <h2 className={c.sectionTitle}>模型配置</h2>
            <button type="button" className={c.btn} onClick={openProviderForm} data-testid="add-provider">
              添加供应商
            </button>
          </div>

          {providers == null ? (
            <div className={c.emptyBox}>
              <EmptyState title="正在读取供应商配置…" />
            </div>
          ) : providerList.length === 0 ? (
            <p className={s.providerEmpty}>还没有供应商</p>
          ) : (
            <ul className={s.providerList} data-testid="provider-list">
              {providerList.map((provider) => (
                <li key={provider.id} className={s.providerRow}>
                  <label className={s.radioLabel}>
                    <input
                      type="radio"
                      name="active-provider"
                      checked={activeProviderId === provider.id}
                      onChange={() => void setActiveProvider(provider.id)}
                    />
                    <span className={s.providerName}>{provider.name}</span>
                  </label>
                  <code className={s.providerUrl} title={provider.baseUrl}>
                    {provider.baseUrl}
                  </code>
                  <span className={s.providerMeta}>{provider.apiFormat}</span>
                  <span
                    className={`${s.keyState} ${provider.credentialConfigured ? s.keyOk : ''}`}
                    title="API Key 只写入系统凭据管理器，界面不显示明文"
                  >
                    {provider.requiresApiKey
                      ? provider.credentialConfigured
                        ? 'Key 已配置'
                        : 'Key 未配置'
                      : '无需 Key'}
                  </span>
                  <div className={s.providerActions}>
                    <button
                      type="button"
                      className={c.btn}
                      onClick={() => openProviderEdit(provider)}
                      data-testid="edit-provider"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className={`${c.btn} ${s.btnDanger}`}
                      onClick={() => {
                        setRemoveTarget(provider);
                        setError(null);
                        setModal('remove-provider');
                      }}
                      data-testid="remove-provider"
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {versionLine ? (
          <div className={s.updateArea}>
            <p className={s.footerMeta}>{versionLine}</p>
            {update && update.status !== 'unsupported' ? (
              <>
                <span className={`${s.updateStatus} ${update.status === 'error' ? s.updateStatusError : ''}`}>
                  {updateText}
                </span>
                {updateAction ? (
                  <button
                    type="button"
                    className={c.btn}
                    onClick={updateAction.run}
                    disabled={update.status === 'checking' || update.status === 'downloading'}
                    data-testid={update.status === 'downloaded' ? 'update-install' : 'update-check'}
                  >
                    {updateAction.label}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {modal === 'add-agent' ? (
        <Modal
          title="新增 Agent"
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setModal(null)}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void submitAddAgent()}
                disabled={busy || !agentNameDraft.trim() || !pathDraft.trim()}
                data-testid="submit-add-agent"
              >
                添加
              </button>
            </>
          }
        >
          <div className={s.form}>
            <label className={s.field}>
              <span className={s.fieldLabel}>Agent 名称</span>
              <input
                className={c.input}
                value={agentNameDraft}
                onChange={(event) => setAgentNameDraft(event.target.value)}
                placeholder="例如 My Tool"
              />
            </label>
            <label className={s.field}>
              <span className={s.fieldLabel}>全局 Skills 目录</span>
              <span className={s.inputWithButton}>
                <input
                  className={c.input}
                  value={pathDraft}
                  onChange={(event) => setPathDraft(event.target.value)}
                  placeholder="D:/tools/my-tool/skills"
                />
                <button
                  type="button"
                  className={c.btn}
                  onClick={() => void pickInto(setPathDraft, '选择 Agent 的 Skills 目录')}
                >
                  选择目录
                </button>
              </span>
            </label>
          </div>
        </Modal>
      ) : null}

      {modal === 'edit-path' && editAgent ? (
        <Modal
          title={`修改 ${editAgent.name} 的 Skills 目录`}
          desc="只改路径，不移动已有技能文件。"
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setModal(null)}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void submitEditPath()}
                disabled={busy || !pathDraft.trim()}
              >
                保存
              </button>
            </>
          }
        >
          <div className={s.form}>
            <label className={s.field}>
              <span className={s.fieldLabel}>全局 Skills 目录</span>
              <span className={s.inputWithButton}>
                <input
                  className={c.input}
                  value={pathDraft}
                  onChange={(event) => setPathDraft(event.target.value)}
                />
                <button
                  type="button"
                  className={c.btn}
                  onClick={() => void pickInto(setPathDraft, '选择 Agent 的 Skills 目录')}
                >
                  选择目录
                </button>
              </span>
            </label>
            {!editAgent.installed ? <p className={s.fieldHint}>当前目录不存在：保存后将按新目录重新检测。</p> : null}
          </div>
        </Modal>
      ) : null}

      {modal === 'move' ? (
        <Modal
          title="更改中心技能库位置"
          desc="技能文件、评测报告和设置会一起迁移，已同步的链接自动指向新位置；失败会退回原位置。"
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setModal(null)}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void confirmMove()}
                disabled={busy}
                data-testid={moveNeedsPolicy ? 'confirm-merge' : 'confirm-move'}
              >
                {moveNeedsPolicy ? '合并到目标目录' : '确认迁移'}
              </button>
            </>
          }
        >
          <div className={s.movePaths}>
            <p className={s.moveLabel}>当前路径</p>
            <code className={s.path}>{libraryPath ?? '—'}</code>
            <p className={s.moveLabel}>新路径</p>
            <code className={s.path}>{moveTarget ?? '—'}</code>
          </div>
          {moveNeedsPolicy ? (
            <p className={s.moveWarn}>
              目标目录非空，只能合并：目标已有技能保持不动，同名但内容不同的会被拦下，不会覆盖。
            </p>
          ) : null}
        </Modal>
      ) : null}

      {modal === 'remove-provider' && removeTarget ? (
        <Modal
          title={`删除供应商 ${removeTarget.name}`}
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setModal(null)}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void submitRemoveProvider()}
                disabled={busy}
                data-testid="confirm-remove-provider"
              >
                删除
              </button>
            </>
          }
        >
          <p className={s.moveWarn}>
            它的模型清单和 Windows 凭据管理器里的 API Key 会一并删除，不能撤销。
            {removeTarget.id === activeProviderId
              ? ' 它当前生效，删除后自动切换到列表里的下一条。'
              : ''}
          </p>
        </Modal>
      ) : null}

      {modal === 'provider' ? (
        <Modal
          title={editingProvider ? '编辑供应商' : '新建供应商'}
          onClose={() => setModal(null)}
          width={600}
          testId="provider-modal"
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setModal(null)}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void submitProvider()}
                disabled={busy || !form.name.trim() || !form.baseUrl.trim()}
                data-testid="submit-provider"
              >
                {editingProvider ? '保存' : '创建供应商'}
              </button>
            </>
          }
        >
          <div className={s.formGrid}>
            <label className={s.field}>
              <span className={s.fieldLabel}>平台预设</span>
              <select
                className={c.input}
                value={form.preset}
                onChange={(event) => applyPreset(event.target.value)}
                disabled={editingProvider !== null}
                title={editingProvider ? '预设决定供应商身份，编辑时不可更换' : undefined}
              >
                {presets.map((preset) => (
                  <option key={preset.preset} value={preset.preset}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.field}>
              <span className={s.fieldLabel}>供应商名称</span>
              <input
                className={c.input}
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="输入名称"
              />
            </label>
            <label className={`${s.field} ${s.fieldWide}`}>
              <span className={s.fieldLabel}>协议类型</span>
              <select
                className={c.input}
                value={form.apiFormat}
                onChange={(event) => setForm((prev) => ({ ...prev, apiFormat: event.target.value }))}
                disabled={form.preset !== 'openai-compatible'}
              >
                {API_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </label>
            <label className={`${s.field} ${s.fieldWide}`}>
              <span className={s.fieldLabel}>API Endpoint (Base URL)</span>
              <input
                className={c.input}
                value={form.baseUrl}
                onChange={(event) => setForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label className={`${s.field} ${s.fieldWide}`}>
              <span className={s.fieldLabel}>API Key</span>
              <input
                className={c.input}
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                placeholder={editingProvider ? '留空则不修改' : '可留空'}
                autoComplete="off"
              />
              {editingProvider?.requiresApiKey ? (
                <span className={s.fieldHint}>
                  {editingProvider.credentialConfigured ? '已保存 Key：留空则沿用原 Key' : '尚未保存 Key：留空则稍后再填'}
                </span>
              ) : null}
            </label>
            <div className={`${s.field} ${s.fieldWide}`} data-testid="provider-model-field">
              <span className={s.fieldLabel}>模型</span>
              <div className={s.modelRows}>
                {form.models.map((model, index) => {
                  const isLast = index === form.models.length - 1;
                  const options = modelRowFocus === index ? modelOptionsFor(index) : [];
                  return (
                    <div key={index} className={s.modelRow}>
                      <div className={s.modelField}>
                        <div className={s.modelSelect}>
                          <input
                            className={s.modelSelectInput}
                            value={model}
                            onChange={(event) => updateFormModel(index, event.target.value)}
                            onFocus={() => setModelRowFocus(index)}
                            onBlur={() =>
                              setModelRowFocus((current) => (current === index ? null : current))
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setModelRowFocus(null);
                            }}
                            placeholder="模型 ID，如 deepseek-flash"
                            autoComplete="off"
                            data-testid="form-model-input"
                          />
                          <button
                            type="button"
                            className={s.modelSelectCaret}
                            aria-label="展开候选模型"
                            aria-expanded={modelRowFocus === index}
                            // 阻止默认行为，避免 input 先失焦把列表关掉
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() =>
                              setModelRowFocus((current) => (current === index ? null : index))
                            }
                            data-testid="form-model-caret"
                          />
                        </div>
                        {modelRowFocus === index && options.length > 0 ? (
                          <ul className={s.modelOptions} data-testid="form-model-options">
                            {options.map((option) => (
                              <li key={option}>
                                <button
                                  type="button"
                                  className={s.modelOption}
                                  // 用 mousedown 抢在 input blur 之前写值，否则列表先关、点击落空
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    updateFormModel(index, option);
                                    setModelRowFocus(null);
                                  }}
                                  data-testid="form-model-option"
                                >
                                  {option}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      {isLast ? (
                        <button
                          type="button"
                          className={c.btn}
                          onClick={addFormModelRow}
                          data-testid="form-model-add"
                        >
                          添加
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={s.modelRowRemove}
                          onClick={() => removeFormModel(index)}
                          aria-label="删除这一行"
                          title="删除这一行"
                          data-testid="form-model-remove"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <span className={s.fieldHint}>一个供应商可添加多个模型；清单外的 ID 也可以直接输入</span>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
