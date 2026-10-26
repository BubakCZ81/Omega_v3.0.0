import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = '127.0.0.1';

function isPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function findPort() {
  for (let port = 5173; port < 5273; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('No free development port was found between 5173 and 5272.');
}

async function waitForServer(url, processHandle) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('Vite stopped before the development server became ready.');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

const port = await findPort();
const serverUrl = `http://${host}:${port}`;
const environment = { ...process.env, OMEGA_DEV_PORT: String(port), OMEGA_DEV_SERVER_URL: serverUrl, NODE_ENV: 'development' };
console.log(`Omega development server: ${serverUrl}`);

const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', host, '--port', String(port), '--strictPort'], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});

let electron = null;
const stop = () => {
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await waitForServer(serverUrl, vite);
  electron = spawn(process.execPath, [path.join(root, 'node_modules/electron/cli.js'), '.'], { cwd: root, env: environment, stdio: 'inherit' });
  const exitCode = await new Promise(resolve => electron.once('exit', code => resolve(code ?? 0)));
  stop();
  process.exitCode = exitCode;
} catch (error) {
  stop();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
