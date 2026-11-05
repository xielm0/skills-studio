import { useEffect, type ReactNode } from 'react';
import s from './Modal.module.css';

interface ModalProps {
  title: string;
  /** 标题下的说明文字（表单用途说明等） */
  desc?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** 面板宽度（默认 560px） */
  width?: number;
  headerActions?: ReactNode;
  closeIcon?: boolean;
  fullscreen?: boolean;
}

/**
 * 浅色平实弹层（design.md「设置与弹层」）：白底、细边框、轻遮罩。
 * Esc 关闭、点击遮罩关闭，不做装饰性动效。
 */
export function Modal({ title, desc, onClose, footer, children, testId, width, headerActions, closeIcon = false, fullscreen = false }: ModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={`${s.overlay} ${fullscreen ? s.overlayFullscreen : ''}`} onMouseDown={onClose} role="presentation">
      <div
        className={`${s.panel} ${fullscreen ? s.panelFullscreen : ''}`}
        style={width && !fullscreen ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={s.header}>
          <div className={s.headerText}>
            <h2 className={s.title}>{title}</h2>
            {desc ? <p className={s.desc}>{desc}</p> : null}
          </div>
          <div className={s.headerActions}>
            {headerActions}
            <button type="button" className={`${s.close} ${closeIcon ? s.closeIcon : ''}`} onClick={onClose} aria-label="关闭" title="关闭">
              {closeIcon ? '×' : '关闭'}
            </button>
          </div>
        </header>
        <div className={s.body}>{children}</div>
        {footer ? <footer className={s.footer}>{footer}</footer> : null}
      </div>
    </div>
  );
}
