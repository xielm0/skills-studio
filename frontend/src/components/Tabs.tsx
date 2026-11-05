import s from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: string;
}

interface TabsProps {
  items: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

/** 平面 Tab：底部 2px 标识当前项（design.md「顶栏、Tab 和筛选工具栏」）。 */
export function Tabs({ items, active, onChange, ariaLabel }: TabsProps) {
  return (
    <div className={s.bar} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`${s.tab} ${selected ? s.tabActive : ''}`}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
