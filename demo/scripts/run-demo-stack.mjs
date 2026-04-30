import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DEMO_DIR, '..');
const CONFIG = 'demo/tests/config/mulder.e2e.config.yaml';
const POSTGRES_CONTAINER = process.env.MULDER_E2E_POSTGRES_CONTAINER ?? 'mulder-postgres';

function runDockerComposePostgres() {
  if (process.env.MULDER_DEMO_SKIP_DOCKER === '1') {
    console.log('[demo:stack] Skipping Docker startup because MULDER_DEMO_SKIP_DOCKER=1');
    return;
  }

  console.log('[demo:stack] Starting local Postgres via docker compose...');
  const result = spawnSync('docker', ['compose', 'up', '-d', 'postgres'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if ((result.status ?? 1) !== 0) {
    console.error('[demo:stack] Failed to start local Postgres. Is Docker running?');
    process.exit(result.status ?? 1);
  }
}

async function waitForPostgres() {
  if (process.env.MULDER_DEMO_SKIP_DOCKER === '1') {
    return;
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', POSTGRES_CONTAINER], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const status = result.stdout.trim();
    if (status === 'healthy') {
      console.log('[demo:stack] Local Postgres is healthy.');
      return;
    }

    if (status === 'unhealthy') {
      console.error(`[demo:stack] Local Postgres reported unhealthy status.`);
      process.exit(1);
    }

    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1000));
  }

  console.error('[demo:stack] Timed out waiting for local Postgres to become healthy.');
  process.exit(1);
}

function runPrepare() {
  const result = spawnSync('npm', ['run', 'demo:prepare'], {
    cwd: DEMO_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      MULDER_ALLOW_LOCAL_E2E_SEEDING: 'local-docker-only',
      MULDER_LOG_LEVEL: 'silent',
    },
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
  let remaining = children.length;
  if (remaining === 0) {
    process.exit(code);
  }

  let force;
  for (const child of children) {
    child.once('exit', () => {
      remaining -= 1;
      if (remaining === 0) {
        clearTimeout(force);
        process.exit(code);
      }
    });

    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  force = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
    process.exit(code);
  }, 3000);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

runDockerComposePostgres();
await waitForPostgres();
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
