/**
 * 路径展示辅助：把用户主目录缩成 `~`，让一行放得下完整路径。
 * 仅用于界面显示，完整路径仍放在元素的 title 里。
 */
export function shortenHome(dir: string): string {
  return dir.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]/i, '~\\');
}
