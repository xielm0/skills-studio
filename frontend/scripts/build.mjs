import { spawnSync } from 'node:child_process';
import { buildEnv } from '../../backend/scripts/env-mode.mjs';

const r = spawnSync('vite', ['build', '--mode', buildEnv()], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
