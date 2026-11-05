import type { ReactNode } from 'react';
import c from '../styles/common.module.css';

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** 标题区下方是否需要分隔线（工具栏自带分隔线时不必重复） */
  bordered?: boolean;
}

/** 主工作区页面标题区：22px/600 标题 + 可选说明与右侧操作。 */
export function PageHeader({ title, subtitle, actions, bordered = false }: PageHeaderProps) {
  return (
    <header className={`${c.header} ${bordered ? c.headerBordered : ''}`}>
      <div className={c.headerMain}>
        <h1 className={c.title}>{title}</h1>
        {subtitle ? <p className={c.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={c.headerActions}>{actions}</div> : null}
    </header>
  );
}
