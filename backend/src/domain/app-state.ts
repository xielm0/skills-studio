/**
 * 本机应用状态（T10：首次启动标记与中心库路径，tec.md §5.11 / §6.2）。
 *
 * 位置：DATA_DIR/app-state.json —— 本机设置，**不进库、不进 Git、不进备份**。
 *  - firstRunCompleted：首启流程只执行一次；写 true 幂等；
 *  - libraryPath：用户「更改目录」后的中心库位置；为空表示使用 env/默认路径。
 *
 * 库内真相仍是 <库>/skills + library.json；这里只保存「本机怎么找到它」。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const APP_STATE_SCHEMA_VERSION = 1;

/** 主页 CLI 接入卡片状态：undecided 从未交互 / dismissed 已关闭 / installed 已接入。 */
export type CliSetupCardState = 'undecided' | 'dismissed' | 'installed';

export interface AppState {
  schemaVersion: number;
  firstRunCompleted: boolean;
  libraryPath: string | null;
  cliSetupCard: CliSetupCardState;
}

export class AppStateService {
  readonly file: string;
  private state: AppState;

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, 'app-state.json');
    this.state = readAppState(this.file);
  }

  /** 当前持久状态（副本）。 */
  get(): AppState {
    return { ...this.state };
  }

  get firstRunCompleted(): boolean {
    return this.state.firstRunCompleted;
  }

  /** 首启完成标记（幂等）。 */
  markFirstRunCompleted(): AppState {
    if (!this.state.firstRunCompleted) {
      this.state = { ...this.state, firstRunCompleted: true };
      this.persist();
    }
    return this.get();
  }

  /** 记录用户选定的中心库路径（null = 回到默认路径）。 */
  setLibraryPath(libraryPath: string | null): AppState {
    const next = libraryPath == null ? null : path.resolve(libraryPath);
    if (this.state.libraryPath !== next) {
      this.state = { ...this.state, libraryPath: next };
      this.persist();
    }
    return this.get();
  }

  /** 记录 CLI 接入卡片的用户决定（关闭 / 接入完成），幂等。 */
  setCliSetupCard(card: CliSetupCardState): AppState {
    if (this.state.cliSetupCard !== card) {
      this.state = { ...this.state, cliSetupCard: card };
      this.persist();
    }
    return this.get();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload: AppState = {
      schemaVersion: APP_STATE_SCHEMA_VERSION,
      firstRunCompleted: this.state.firstRunCompleted,
      libraryPath: this.state.libraryPath,
      cliSetupCard: this.state.cliSetupCard,
    };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
    this.state = payload;
  }
}

/** 容错读取：损坏或缺失按全新状态处理（本机设置丢失不损坏用户库）。 */
export function readAppState(file: string): AppState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppState>;
    return {
      schemaVersion: APP_STATE_SCHEMA_VERSION,
      firstRunCompleted: parsed.firstRunCompleted === true,
      libraryPath:
        typeof parsed.libraryPath === 'string' && path.isAbsolute(parsed.libraryPath) ? parsed.libraryPath : null,
      cliSetupCard:
        parsed.cliSetupCard === 'dismissed' || parsed.cliSetupCard === 'installed'
          ? parsed.cliSetupCard
          : 'undecided',
    };
  } catch {
    return { schemaVersion: APP_STATE_SCHEMA_VERSION, firstRunCompleted: false, libraryPath: null, cliSetupCard: 'undecided' };
  }
}
