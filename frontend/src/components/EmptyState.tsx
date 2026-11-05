import c from '../styles/common.module.css';

interface EmptyStateProps {
  title: string;
  desc?: string;
  /** boxed：带 1px 细边框的占位块；plain：无边框（用于表格或面板内部） */
  variant?: 'plain' | 'boxed';
}

/** 统一空态：仅说明当前状态，不放装饰性插画。 */
export function EmptyState({ title, desc, variant = 'plain' }: EmptyStateProps) {
  return (
    <div className={`${c.empty} ${variant === 'boxed' ? c.emptyBox : ''}`}>
      <p className={c.emptyTitle}>{title}</p>
      {desc ? <p className={c.emptyDesc}>{desc}</p> : null}
    </div>
  );
}
