import { app, BrowserWindow, dialog } from 'electron';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let win = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(origin) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${origin}/api/users`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('il server locale non risponde');
}

async function start() {
  await app.whenReady();
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    dialog.showErrorBox('Portfolio Manager', 'Interfaccia non compilata: esegui "npm run build".');
    return app.quit();
  }
  const port = await freePort();
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(port);
  // Il server gira in questo processo: chiudere l'app lo arresta.
  await import('../server/index.js');
  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(origin);

  win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Portfolio Manager',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });
  await win.loadURL(origin);
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  start().catch((error) => {
    dialog.showErrorBox('Portfolio Manager', error.message);
    app.quit();
  });
} else {
  app.quit();
}
