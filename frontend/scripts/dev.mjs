import { spawnSync } from 'node:child_process';
import { currentEnv } from '../../backend/scripts/env-mode.mjs';

const r = spawnSync('vite', ['--mode', currentEnv()], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
