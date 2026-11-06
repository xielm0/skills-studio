/** 导航与外壳图标：16px 线性图标，描边 1.5，颜色继承当前文字色。 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 7.2 8 2.5l5.5 4.7v6.3h-3.6V9.7H6.1v3.8H2.5z" />
    </Svg>
  );
}

export function LibraryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 6.6h11M6.4 6.6v6.9" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5h4l1.4 1.7H14v6.3H2z" />
    </Svg>
  );
}

export function InstallIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5v7.2M4.9 6.9 8 10l3.1-3.1M2.5 13.5h11" />
    </Svg>
  );
}

export function BackupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.8" width="11" height="3.2" rx="1" />
      <path d="M3.6 6v6.2a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V6M6.4 8.6h3.2" />
    </Svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 3.5h11v8H9l-3.2 2.4v-2.4H2.5z" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 5.2h11M2.5 10.8h11" />
      <circle cx="6.2" cy="5.2" r="1.6" fill="var(--c-bg-nav, #faf9f8)" />
      <circle cx="10" cy="10.8" r="1.6" fill="var(--c-bg-nav, #faf9f8)" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.5 13.5" />
    </Svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 12.6V3.8M4.7 7.1 8 3.8l3.3 3.3" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.2 6.4 8 10.2l3.8-3.8" />
    </Svg>
  );
}

/** 运行中的中断：实心方块（与发送共用同一个圆形按钮）。 */
export function StopIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.4" fill="currentColor" />
    </svg>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.8 3.5a1.5 1.5 0 0 1 2.1 0l.6.6a1.5 1.5 0 0 1 0 2.1L6.2 12.5l-2.9.6.6-2.9z" />
    </Svg>
  );
}

export function EllipsisIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="3.4" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="8" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="4.5" width="11" height="8" rx="2" />
      <path d="M8 4.5v-2M5.5 8.5h.1M10.4 8.5h.1M6 11h4" />
    </Svg>
  );
}
