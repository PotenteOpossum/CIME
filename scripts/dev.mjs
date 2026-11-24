import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkPort } from './ports.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 22 || minor < 12) {
  console.error('CIME requires Node.js 22.12 or newer in the 22.x line. Run: nvm use');
  process.exit(1);
}

for (const name of ['backend', 'frontend', 'admin-frontend']) {
  if (!existsSync(path.join(root, name, 'node_modules'))) {
    console.error(`Missing ${name} dependencies. Run: npm run install:all`);
    process.exit(1);
  }
}
if (!existsSync(path.join(root, 'backend/.env'))) {
  console.error('Missing backend/.env. Follow Local setup in README.md first.');
  process.exit(1);
}

const requireBackend = createRequire(path.join(root, 'backend/package.json'));
const dotenv = requireBackend('dotenv');
const config = {
  ...dotenv.parse(readFileSync(path.join(root, 'backend/.env'))),
  ...process.env,
};
if (config.NODE_ENV === 'production') {
  console.error('For a persistent production server, use npm run server:start.');
  process.exit(1);
}
try {
  // Probe every port before starting any service; never kill an existing process.
  for (const [port, host] of [
    [Number(config.PORT || 4000), config.HOST || '127.0.0.1'],
    [5173, '127.0.0.1'],
    [5174, '127.0.0.1'],
  ]) await checkPort(port, host);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const services = [
  ['backend', ['--watch', 'src/platform/server.js']],
  ['frontend', ['node_modules/vite/bin/vite.js']],
  ['admin-frontend', ['node_modules/vite/bin/vite.js']],
];
const children = new Set();
const processGroups = new Set();
let stopping = false;
let exitCode = 0;
let forceStop;

function signalAll(signal) {
  for (const pid of processGroups) {
    try {
      // Each service has its own process group, including watcher/worker children.
      process.kill(process.platform === 'win32' ? pid : -pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(error.message);
    }
  }
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  console.log('\nStopping CIME services...');
  signalAll('SIGTERM');
  forceStop = setTimeout(() => {
    signalAll('SIGKILL');
    process.exit(exitCode);
  }, 5000);
  if (children.size === 0) {
    clearTimeout(forceStop);
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

console.log('Starting CIME at http://localhost:5173 — press Ctrl+C to stop everything.');
for (const [name, args] of services) {
  const child = spawn(process.execPath, args, {
    cwd: path.join(root, name),
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  children.add(child);
  if (child.pid) processGroups.add(child.pid);
  child.on('error', (error) => {
    console.error(`[${name}] ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[${name}] exited (${signal || code}).`);
      stop(code || 1);
    }
  });
  child.on('close', () => {
    children.delete(child);
    if (stopping && children.size === 0) {
      clearTimeout(forceStop);
      process.exit(exitCode);
    }
  });
}
