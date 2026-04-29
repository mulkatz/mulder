import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DEMO_DIR, '..');
const CONFIG = 'demo/tests/config/mulder.e2e.config.yaml';

function runPrepare() {
  const result = spawnSync('npm', ['run', 'demo:prepare'], {
    cwd: DEMO_DIR,
    stdio: 'inherit',
    env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
  });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function spawnService(name, command, args, options) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      MULDER_CONFIG: CONFIG,
      MULDER_LOG_LEVEL: 'silent',
      NODE_ENV: 'development',
      ...options.env,
    },
    cwd: options.cwd,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    console.error(`[demo:stack] ${name} exited unexpectedly (${signal ?? code ?? 'unknown'})`);
    shutdown(code ?? 1);
  });

  return child;
}

let shuttingDown = false;
let children = [];

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  const force = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
    process.exit(code);
  }, 3000);

  force.unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

runPrepare();

children = [
  spawnService('api', 'node', ['apps/api/dist/index.js'], {
    cwd: ROOT,
    env: { MULDER_API_PORT: '8080' },
  }),
  spawnService('worker', 'node', ['apps/cli/dist/index.js', 'worker', 'start', '--poll-interval', '250', '--concurrency', '1'], {
    cwd: ROOT,
    env: {},
  }),
  spawnService('vite', 'npm', ['run', 'demo:web'], {
    cwd: DEMO_DIR,
    env: {
      VITE_API_PROXY_TARGET: 'http://127.0.0.1:8080',
      VITE_PREVIEW_AUTH_BYPASS: 'false',
    },
  }),
];
