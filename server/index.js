import express from 'express';
import multer from 'multer';
import { readFile, writeFile, readdir, stat, unlink, mkdir, rm } from 'fs/promises';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../src/js/portfolio-engine.js';
import { fetchPricesForCsv } from './prices.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const DATA_DIR = process.env.PORTFOLIO_DATA_DIR || join(PROJECT_ROOT, 'server', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

const app = express();
const PORT = process.env.PORT || 3001;
// Le API non hanno autenticazione: il server ascolta solo sull'interfaccia di loopback.
const HOST = '127.0.0.1';
const MAX_USER_NAME_LENGTH = 80;
let viteServer = null;
let httpServer = null;

function isLoopbackHostname(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname).toLowerCase());
}

function hostnameFromHostHeader(value) {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

// Solo richieste locali: blocca DNS rebinding (Host estraneo) e richieste
// cross-site da pagine web aperte nello stesso browser (Origin estraneo).
// Non c'è CORS: l'interfaccia è servita dalla stessa origine o dal proxy di Vite.
app.use((req, res, next) => {
  const host = hostnameFromHostHeader(req.headers.host ?? '');
  if (!host || !isLoopbackHostname(host)) {
    return res.status(403).json({ error: 'Host non consentito: il server accetta solo richieste locali.' });
  }
  const { origin } = req.headers;
  if (origin !== undefined) {
    let originHost = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      originHost = null;
    }
    if (!originHost || !isLoopbackHostname(originHost)) {
      return res.status(403).json({ error: 'Origine non consentita: il server accetta solo richieste dalla pagina locale.' });
    }
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

app.post('/__shutdown', (req, res) => {
  const address = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    return res.status(403).json({ error: 'Arresto consentito solo in locale' });
  }

  res.status(202).json({ stopping: true });
  setTimeout(async () => {
    try {
      await viteServer?.close();
    } catch (error) {
      console.error('Vite shutdown failed:', error);
    }
    httpServer?.close((error) => {
      if (error) console.error('HTTP shutdown failed:', error);
    });
  }, 100);
});

// Multer config: salva file in memoria, noi decidiamo dove scriverli
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max per file
  fileFilter: (_req, file, cb) => {
    if (extname(file.originalname).toLowerCase() !== '.csv') {
      const error = new Error(`Solo file .csv sono ammessi (${file.originalname}).`);
      error.code = 'NOT_CSV';
      return cb(error);
    }
    cb(null, true);
  },
});

// Traduce gli errori di multer in risposte JSON comprensibili dal client.
function receiveCsvFiles(req, res, next) {
  upload.array('files')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File troppo grande: il limite è 10 MB per file.' });
    }
    if (error.code === 'NOT_CSV') {
      return res.status(400).json({ error: error.message });
    }
    return res.status(400).json({ error: `Caricamento non valido: ${error.message}` });
  });
}

// =============================================================================
// User Management
// =============================================================================

async function loadUsers() {
  let content;
  try {
    content = await readFile(USERS_FILE, 'utf-8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Primo avvio: nessun file profili.
    const defaultUsers = {
      currentUserId: 'user-1',
      users: [
        { id: 'user-1', name: 'Utente Principale', createdAt: new Date().toISOString() }
      ]
    };
    await saveUsers(defaultUsers);
    return defaultUsers;
  }
  try {
    const data = JSON.parse(content);
    if (!Array.isArray(data?.users)) throw new Error('struttura non valida');
    return data;
  } catch (error) {
    // Non sovrascrivere: il file potrebbe contenere profili recuperabili a mano.
    throw new Error(`users.json non leggibile (${error.message}); il file non è stato modificato.`);
  }
}

function validUserName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= MAX_USER_NAME_LENGTH;
}

async function saveUsers(data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(data, null, 2));
}

function getUserCsvDir(userId) {
  return join(DATA_DIR, 'csv', userId);
}

// Prezzi estratti al caricamento, legati al CSV: eliminando il CSV spariscono con lui.
function pricesFile(userId, csvId) {
  return join(DATA_DIR, 'prices', userId, `${csvId}.json`);
}

async function readPrices(userId, csvId) {
  try {
    return JSON.parse(await readFile(pricesFile(userId, csvId), 'utf-8'));
  } catch {
    return null;
  }
}

async function savePrices(userId, csvId, snapshot) {
  await mkdir(join(DATA_DIR, 'prices', userId), { recursive: true });
  await writeFile(pricesFile(userId, csvId), JSON.stringify(snapshot, null, 2));
}

async function ensureUserCsvDir(userId) {
  const dir = getUserCsvDir(userId);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Nome salvato: <timestamp 19 caratteri>_<nome pulito>[~n].csv. Il suffisso ~n
// (carattere escluso dai nomi puliti) evita sovrascritture nello stesso secondo.
function makeStoredName(originalName, attempt = 0) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cleanName = originalName.replace(/\.csv$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${timestamp}_${cleanName}${attempt ? `~${attempt + 1}` : ''}.csv`;
}

async function writeNewCsv(csvDir, originalName, buffer) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const storedName = makeStoredName(originalName, attempt);
    try {
      await writeFile(join(csvDir, storedName), buffer, { flag: 'wx' });
      return storedName;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Impossibile assegnare un nome univoco al file.');
}

function displayName(storedName) {
  return storedName.slice(20).replace(/~\d+(\.csv)$/i, '$1');
}

// Ordine di caricamento: timestamp nel nome, poi data di creazione, poi nome.
function byUploadOrder(a, b) {
  return a.storedName.slice(0, 19).localeCompare(b.storedName.slice(0, 19)) ||
    a.createdMs - b.createdMs ||
    a.storedName.localeCompare(b.storedName);
}

// =============================================================================
// API: Users
// =============================================================================

// GET /api/users — lista tutti gli utenti
app.get('/api/users', async (_req, res) => {
  try {
    const data = await loadUsers();
    res.json(data);
  } catch (err) {
    console.error('Load users error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — crea un nuovo utente
app.post('/api/users', async (req, res) => {
  try {
    const { name } = req.body ?? {};
    if (!validUserName(name)) {
      return res.status(400).json({ error: `Nome utente obbligatorio (massimo ${MAX_USER_NAME_LENGTH} caratteri)` });
    }

    const data = await loadUsers();
    const newUser = {
      id: `user-${Date.now()}`,
      name: name.trim(),
      createdAt: new Date().toISOString(),
    };

    data.users.push(newUser);
    data.currentUserId = newUser.id;
    await saveUsers(data);

    // Crea directory CSV per il nuovo utente
    await ensureUserCsvDir(newUser.id);

    res.status(201).json({ user: newUser, currentUserId: data.currentUserId });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id — aggiorna utente
app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body ?? {};

    const data = await loadUsers();
    const userIndex = data.users.findIndex(u => u.id === id);
    if (userIndex === -1) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    if (name !== undefined) {
      if (!validUserName(name)) {
        return res.status(400).json({ error: `Nome utente obbligatorio (massimo ${MAX_USER_NAME_LENGTH} caratteri)` });
      }
      data.users[userIndex].name = name.trim();
    }

    await saveUsers(data);
    res.json({ user: data.users[userIndex] });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id — elimina utente (e i suoi CSV)
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const data = await loadUsers();

    const userIndex = data.users.findIndex(u => u.id === id);
    if (userIndex === -1) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    if (data.users.length <= 1) {
      return res.status(400).json({ error: 'Impossibile eliminare l\'unico utente' });
    }

    // Elimina directory CSV dell'utente
    const userCsvDir = getUserCsvDir(id);
    try {
      await rm(userCsvDir, { recursive: true, force: true });
      await rm(join(DATA_DIR, 'prices', id), { recursive: true, force: true });
      await rm(stateFile(id), { force: true });
    } catch {
      // Directory might not exist
    }

    data.users.splice(userIndex, 1);

    // Se era l'utente corrente, passa al primo
    if (data.currentUserId === id) {
      data.currentUserId = data.users[0].id;
    }

    await saveUsers(data);
    res.json({ success: true, currentUserId: data.currentUserId });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/switch — cambia utente corrente
app.post('/api/users/switch', async (req, res) => {
  try {
    const { userId } = req.body ?? {};
    const data = await loadUsers();

    if (!data.users.find(u => u.id === userId)) {
      return res.status(404).json({ error: 'Utente non trovato' });
    }

    data.currentUserId = userId;
    await saveUsers(data);
    res.json({ currentUserId: data.currentUserId });
  } catch (err) {
    console.error('Switch user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// API: CSV Archiving (per utente corrente)
// =============================================================================

// Middleware per ottenere l'utente corrente
async function getCurrentUser(req, res, next) {
  try {
    const data = await loadUsers();
    req.currentUser = data.users.find(u => u.id === data.currentUserId);
    req.currentUserId = data.currentUserId;
    if (!req.currentUser) {
      return res.status(401).json({ error: 'Utente non trovato' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Impostazioni e metadati (saldi, ordine CSV, prezzi manuali) per utente: server/data/state/<utente>.json
const STATE_KEYS = ['settings', 'imports'];

function stateFile(userId) {
  return join(DATA_DIR, 'state', `${userId}.json`);
}

async function readState(userId) {
  try {
    return JSON.parse(await readFile(stateFile(userId), 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

app.get('/api/state', getCurrentUser, async (req, res) => {
  try {
    res.json(await readState(req.currentUserId));
  } catch (err) {
    res.status(500).json({ error: `Stato non leggibile: ${err.message}` });
  }
});

app.put('/api/state/:key', getCurrentUser, async (req, res) => {
  try {
    const { key } = req.params;
    if (!STATE_KEYS.includes(key)) return res.status(400).json({ error: 'Chiave non valida' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Corpo JSON non valido' });
    }
    const state = await readState(req.currentUserId);
    state[key] = req.body;
    await mkdir(join(DATA_DIR, 'state'), { recursive: true });
    await writeFile(stateFile(req.currentUserId), JSON.stringify(state, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('Save state error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/csv/upload — carica uno o più CSV per l'utente corrente
app.post('/api/csv/upload', getCurrentUser, receiveCsvFiles, async (req, res) => {
  try {
    const csvDir = await ensureUserCsvDir(req.currentUserId);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nessun file caricato' });
    }

    const saved = [];
    const errors = [];

    for (const file of req.files) {
      try {
        const content = file.buffer.toString('utf-8');
        // Un file senza intestazioni valide o senza righe valide non entra
        // nell'archivio: altrimenti verrebbe riproposto a ogni avvio.
        try {
          parseCsv(content);
        } catch (validationError) {
          errors.push({ file: file.originalname, error: validationError.message });
          continue;
        }
        const storedName = await writeNewCsv(csvDir, file.originalname, file.buffer);
        // Estrazione best-effort: un errore di rete non blocca il caricamento.
        let prices = null;
        try {
          prices = await fetchPricesForCsv(content);
          await savePrices(req.currentUserId, storedName, prices);
        } catch (priceError) {
          console.warn(`Estrazione prezzi non riuscita per ${storedName}: ${priceError.message}`);
          prices = null;
        }

        saved.push({
          id: storedName,
          name: file.originalname,
          storedName,
          size: file.size,
          content,
          prices,
          uploadedAt: new Date().toISOString(),
        });
      } catch (err) {
        errors.push({ file: file.originalname, error: err.message });
      }
    }

    res.json({ saved, errors });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/csv/list — lista CSV dell'utente corrente
app.get('/api/csv/list', getCurrentUser, async (req, res) => {
  try {
    const csvDir = await ensureUserCsvDir(req.currentUserId);
    const files = await readdir(csvDir);
    const csvFiles = files.filter(f => extname(f).toLowerCase() === '.csv');

    const list = await Promise.all(csvFiles.map(async (storedName) => {
      const filePath = join(csvDir, storedName);
      const stats = await stat(filePath);
      return {
        id: storedName,
        name: displayName(storedName),
        storedName,
        size: stats.size,
        prices: await readPrices(req.currentUserId, storedName),
        uploadedAt: stats.birthtime.toISOString(),
        createdMs: stats.birthtimeMs,
      };
    }));

    list.sort(byUploadOrder);
    res.json({ files: list.map(({ createdMs, ...file }) => file) });
  } catch (err) {
    console.error('List error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/csv/stats — statistiche di importazione (include tipi sconosciuti) per tutti i CSV
app.get('/api/csv/stats', getCurrentUser, async (req, res) => {
  try {
    const csvDir = await ensureUserCsvDir(req.currentUserId);
    const files = await readdir(csvDir);
    const csvFiles = files.filter(f => extname(f).toLowerCase() === '.csv');

    const stats = await Promise.all(csvFiles.map(async (storedName) => {
      const filePath = join(csvDir, storedName);
      const fileStat = await stat(filePath);
      const content = await readFile(filePath, 'utf-8');
      const originalName = displayName(storedName);
      let parsed;
      try {
        parsed = parseCsv(content);
      } catch (error) {
        return {
          id: storedName,
          name: originalName,
          uploadedAt: fileStat.birthtime.toISOString(),
          error: error.message,
          count: 0,
          invalid: 1,
          duplicates: 0,
          unknownTypes: [],
        };
      }
      // Count duplicates within this file (simplified: based on transaction_id)
      const seenIds = new Set();
      let duplicates = 0;
      for (const row of parsed.rows) {
        if (seenIds.has(row.transaction_id)) {
          duplicates += 1;
        } else {
          seenIds.add(row.transaction_id);
        }
      }
      return {
        id: storedName,
        name: originalName,
        uploadedAt: fileStat.birthtime.toISOString(),
        count: parsed.rows.length - duplicates,
        invalid: parsed.errors.length,
        duplicates,
        message: parsed.errors.slice(0, 3).join(' '),
        unknownTypes: parsed.unknownTypes,
      };
    }));

    stats.sort((a, b) => a.id.slice(0, 19).localeCompare(b.id.slice(0, 19)) || a.id.localeCompare(b.id));
    res.json({ stats });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/csv/:id — restituisce contenuto CSV dell'utente corrente
app.get('/api/csv/:id', getCurrentUser, async (req, res) => {
  try {
    const { id } = req.params;
    if (id.includes('/') || id.includes('\\') || extname(id).toLowerCase() !== '.csv') {
      return res.status(400).json({ error: 'ID file non valido' });
    }

    const csvDir = getUserCsvDir(req.currentUserId);
    const filePath = join(csvDir, id);
    const content = await readFile(filePath, 'utf-8');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.send(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File non trovato' });
    }
    console.error('Read CSV error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/csv/:id — elimina CSV dell'utente corrente
app.delete('/api/csv/:id', getCurrentUser, async (req, res) => {
  try {
    const { id } = req.params;
    if (id.includes('/') || id.includes('\\') || extname(id).toLowerCase() !== '.csv') {
      return res.status(400).json({ error: 'ID file non valido' });
    }

    const csvDir = getUserCsvDir(req.currentUserId);
    const filePath = join(csvDir, id);
    await unlink(filePath);
    await unlink(pricesFile(req.currentUserId, id)).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File non trovato' });
    }
    console.error('Delete CSV error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/feedback/unknown-types — salva report tipi sconosciuti
app.post('/api/feedback/unknown-types', getCurrentUser, async (req, res) => {
  try {
    const report = req.body;
    if (!report || !Array.isArray(report.files) || !report.files.every((item) => item && typeof item === 'object')) {
      return res.status(400).json({ error: 'Report non valido' });
    }

    const feedbackDir = join(DATA_DIR, 'feedback');
    await mkdir(feedbackDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `unknown-types-report-${timestamp}.json`;
    const filePath = join(feedbackDir, fileName);

    const reportWithMeta = {
      ...report,
      userId: req.currentUserId,
      userName: req.currentUser.name,
      savedAt: new Date().toISOString(),
    };

    await writeFile(filePath, JSON.stringify(reportWithMeta, null, 2));
    res.json({ success: true, fileName });
  } catch (err) {
    console.error('Save feedback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Serving static files (produzione) / Proxy Vite (sviluppo)
// =============================================================================

const isDev = process.env.NODE_ENV !== 'production';

// Le rotte /api sconosciute rispondono 404 JSON invece della pagina HTML.
app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Endpoint API inesistente' });
});

if (isDev) {
  const { createServer: createViteServer } = await import('vite');
  viteServer = await createViteServer({
    server: { middlewareMode: true },
    root: join(PROJECT_ROOT, 'src'),
  });
  app.use(viteServer.middlewares);
} else {
  const distIndex = join(PROJECT_ROOT, 'dist', 'index.html');
  let distReady = false;
  try {
    await stat(distIndex);
    distReady = true;
  } catch {
    // Build assente: l'interfaccia non è compilata.
  }
  if (distReady) {
    app.use(express.static(join(PROJECT_ROOT, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(distIndex);
    });
  } else {
    app.get('*', (_req, res) => {
      res.status(200).send('<html><body><h1>Portfolio Manager</h1><p>Interfaccia non compilata: esegui "npm run build".</p></body></html>');
    });
  }
}

// =============================================================================
// Start
// =============================================================================

// Errori residui (es. JSON malformato) sempre in formato JSON.
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Corpo JSON non valido' });
  }
  console.error('Unhandled error:', error);
  return res.status(500).json({ error: 'Errore interno del server' });
});

httpServer = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT} (solo locale)`);
  console.log(`Data directory: ${DATA_DIR}`);
});