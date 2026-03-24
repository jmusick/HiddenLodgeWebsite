import { spawn } from 'node:child_process';
import process from 'node:process';

const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  console.error('Unable to determine npm executable path from npm_execpath.');
  process.exit(1);
}

let shuttingDown = false;
const children = [];
const forwardedArgs = process.argv.slice(2);

function startScript(name, args = []) {
  const child = spawn(process.execPath, [npmExecPath, 'run', name, ...(args.length ? ['--', ...args] : [])], {
    stdio: 'inherit',
    env: process.env,
  });

  children.push({ name, child });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    console.log(`${name} stopped with ${reason}. Shutting down dev supervisor.`);
    void shutdown(code ?? (signal ? 1 : 0));
  });

  child.on('error', (error) => {
    if (shuttingDown) return;

    console.error(`${name} failed to start:`, error);
    void shutdown(1);
  });

  return child;
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.killed) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    });

    await new Promise((resolve) => {
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }

  child.kill('SIGTERM');
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  await Promise.all(children.map(({ child }) => terminateChild(child)));
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('SIGTERM', () => {
  void shutdown(0);
});

console.log('Starting Astro dev server and local cron refresher...');
startScript('dev:site', forwardedArgs);
startScript('cron:local');
