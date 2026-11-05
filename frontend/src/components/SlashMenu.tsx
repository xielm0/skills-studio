import s from './SlashMenu.module.css';

/** 一条候选：名称是插入内容，描述是右侧的辅助信息。 */
export interface SlashCandidate {
  readonly name: string;
  readonly description: string;
}

/**
 * 输入 `/` 打开的 Skill 候选层（照 DSH ui-input-trigger MenuView）：
 * 锚在输入卡正上方、与其同宽；行内名称在左、描述右对齐。
 *
 * 焦点始终留在 textarea（combobox 模式），所以行用 mousedown 选中并阻止默认行为，
 * 高亮由调用方通过 `highlight` 传入。
 */
export function SlashMenu({
  items,
  highlight,
  onPick,
  onHover,
}: {
  items: readonly SlashCandidate[];
  highlight: number;
  onPick: (item: SlashCandidate) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className={s.menu} data-testid="slash-menu">
      <div className={s.groupTitle}>技能</div>
      <div className={s.viewport} role="listbox" aria-label="Skill 候选">
        {items.map((item, index) => (
          <button
            key={item.name}
            type="button"
            role="option"
            aria-selected={index === highlight}
            className={`${s.item} ${index === highlight ? s.itemActive : ''}`}
            onMouseDown={(event) => {
              // mousedown 而非 click：不让 textarea 失焦，选中先于 blur 发生
              event.preventDefault();
              onPick(item);
            }}
            onMouseMove={index === highlight ? undefined : () => onHover(index)}
          >
            <span className={s.itemName}>{item.name}</span>
            {item.description ? <span className={s.itemDescription}>{item.description}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
