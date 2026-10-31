import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(homedir(), '.local', 'share', 'applications');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'portfolio-manager-app.desktop');
const icon = join(root, 'electron', 'assets', 'icon.png');
// Binario reale: lo script node_modules/.bin/electron richiede `node` nel PATH, assente fuori dal terminale (nvm).
// ELECTRON_DISABLE_SANDBOX=1 evita l'errore SUID sandbox su Linux senza permessi root su chrome-sandbox.
// L'app è solo locale (127.0.0.1, nessuna rete): il trade-off è accettabile.
writeFileSync(file, `[Desktop Entry]
Type=Application
Name=Portfolio Manager
Comment=Trade Republic - Portfolio Manager
Icon=${icon}
Exec=env ELECTRON_DISABLE_SANDBOX=1 "${join(root, 'node_modules', 'electron', 'dist', 'electron')}" "${join(root, 'electron', 'main.mjs')}"
Path=${root}
Terminal=false
Categories=Office;Finance;
`);
console.log(`Creato ${file}`);
