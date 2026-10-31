// Test d'integrazione delle API di server/index.js.
// Ogni server usa una directory dati temporanea (PORTFOLIO_DATA_DIR): nessun dato
// reale viene letto o scritto. Le verifiche di sicurezza sono locali e difensive.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(projectRoot, 'tests', 'fixtures');
const fixture = (folder, name) => readFile(join(fixtures, folder, name), 'utf-8');

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function startServer(dataDir, mode = 'production') {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: mode, PORT: String(port), PORTFOLIO_DATA_DIR: dataDir, PORTFOLIO_SKIP_PRICES: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${base}/api/users`);
      return { child, base, port, output: () => output };
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  child.kill();
  throw new Error(`Server non avviato: ${output}`);
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill();
  await once(server.child, 'exit');
}

async function upload(base, files) {
  const form = new FormData();
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  const response = await fetch(`${base}/api/csv/upload`, { method: 'POST', body: form });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: response.status, type: response.headers.get('content-type'), body };
}

// fetch() non permette di impostare l'header Host: per il test DNS rebinding serve node:http.
function getWithHost(port, path, host) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolveRequest(res.statusCode));
    });
    req.on('error', rejectRequest);
    req.end();
  });
}

async function clearArchive(base) {
  const files = (await (await fetch(`${base}/api/csv/list`)).json()).files ?? [];
  for (const item of files) await fetch(`${base}/api/csv/${item.id}`, { method: 'DELETE' });
}

const json = (method, body, headers = {}) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

let dataDir;
let server;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pm-api-test-'));
  server = await startServer(dataDir);
});

after(async () => {
  await stopServer(server);
  await rm(dataDir, { recursive: true, force: true });
});

test('profili: elenco iniziale, creazione, rinomina, cambio, errori e vincolo sull’ultimo profilo', async () => {
  const { base } = server;
  let response = await fetch(`${base}/api/users`);
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.users.map((user) => user.id), ['user-1']);

  response = await fetch(`${base}/api/users`, json('POST', { name: '  Profilo Test  ' }));
  body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.user.name, 'Profilo Test');
  const testId = body.user.id;

  for (const name of ['', '   ', 5, null, ['x']]) {
    response = await fetch(`${base}/api/users`, json('POST', { name }));
    assert.equal(response.status, 400, `nome non valido ${JSON.stringify(name)}`);
  }
  response = await fetch(`${base}/api/users`, json('POST', { name: 'x'.repeat(81) }));
  assert.equal(response.status, 400, 'nome oltre 80 caratteri');

  response = await fetch(`${base}/api/users/${testId}`, json('PUT', { name: 'Profilo Rinominato' }));
  assert.equal((await response.json()).user.name, 'Profilo Rinominato');
  response = await fetch(`${base}/api/users/${testId}`, json('PUT', { name: '' }));
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/users/inesistente`, json('PUT', { name: 'X' }));
  assert.equal(response.status, 404);

  response = await fetch(`${base}/api/users/switch`, json('POST', { userId: 'inesistente' }));
  assert.equal(response.status, 404);
  response = await fetch(`${base}/api/users/switch`, json('POST', { userId: 'user-1' }));
  assert.equal((await response.json()).currentUserId, 'user-1');

  response = await fetch(`${base}/api/users/inesistente`, { method: 'DELETE' });
  assert.equal(response.status, 404);
  response = await fetch(`${base}/api/users/${testId}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/users/user-1`, { method: 'DELETE' });
  assert.equal(response.status, 400, 'l’ultimo profilo non è eliminabile');
  response = await fetch(`${base}/api/users/inesistente`, { method: 'DELETE' });
  assert.equal(response.status, 404, 'risorsa inesistente anche con un solo profilo');
});

test('archivio CSV: upload singolo e multiplo, lista, lettura, statistiche, eliminazione', async (t) => {
  const { base } = server;
  t.after(() => clearArchive(base));
  const gen = await fixture('valid', 'SYN_GEN_25.csv');
  const feb = await fixture('valid', 'SYN_FEB_25.csv');
  let result = await upload(base, [['GEN_25.csv', gen]]);
  assert.equal(result.status, 200);
  assert.equal(result.body.saved.length, 1);
  result = await upload(base, [['FEB_25.csv', feb], ['UNK.csv', await fixture('invalid', 'INV_unknown_type.csv')]]);
  assert.equal(result.body.saved.length, 2);

  const list = await (await fetch(`${base}/api/csv/list`)).json();
  assert.deepEqual(list.files.map((item) => item.name), ['GEN_25.csv', 'FEB_25.csv', 'UNK.csv'], 'ordine di caricamento');

  const first = list.files[0].id;
  const read = await fetch(`${base}/api/csv/${first}`);
  assert.equal(read.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(await read.text(), gen);

  const stats = (await (await fetch(`${base}/api/csv/stats`)).json()).stats;
  const unknown = stats.find((item) => item.name === 'UNK.csv');
  assert.deepEqual(unknown.unknownTypes.map((item) => [item.type, item.count]), [['SYNTHETIC_UNKNOWN', 2], ['', 1]]);
  assert.equal(stats.find((item) => item.name === 'FEB_25.csv').count, 8, 'i duplicati tra file sono gestiti dal client');

  for (const bad of ['..%2Fusers.json', 'users.json', 'nonesiste.csv']) {
    const response = await fetch(`${base}/api/csv/${bad}`);
    assert.ok([400, 404].includes(response.status), `${bad} → ${response.status}`);
  }
  let response = await fetch(`${base}/api/csv/${first}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/csv/${first}`, { method: 'DELETE' });
  assert.equal(response.status, 404);
  for (const item of list.files.slice(1)) await fetch(`${base}/api/csv/${item.id}`, { method: 'DELETE' });
});

test('archivio CSV: file non CSV, oltre il limite e CSV non validi rispondono con JSON e non vengono salvati', async (t) => {
  const { base } = server;
  await clearArchive(base);
  t.after(() => clearArchive(base));
  let result = await upload(base, [['note.txt', 'testo']]);
  assert.equal(result.status, 400);
  assert.match(result.type, /application\/json/);
  assert.match(result.body.error, /\.csv/);

  result = await upload(base, [['grande.csv', 'x'.repeat(10 * 1024 * 1024 + 1)]]);
  assert.equal(result.status, 413);
  assert.match(result.type, /application\/json/);

  result = await upload(base, []);
  assert.equal(result.status, 400);

  const valid = await fixture('valid', 'SYN_GEN_25.csv');
  result = await upload(base, [
    ['valido.csv', valid],
    ['senza_intestazioni.csv', await fixture('invalid', 'INV_missing_header.csv')],
    ['nessuna_riga_valida.csv', await fixture('invalid', 'INV_no_valid_rows.csv')],
  ]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.saved.map((item) => item.name), ['valido.csv']);
  assert.deepEqual(result.body.errors.map((item) => item.file), ['senza_intestazioni.csv', 'nessuna_riga_valida.csv']);
  const stored = await readdir(join(dataDir, 'csv', 'user-1'));
  assert.equal(stored.length, 1, 'i file rifiutati non restano nell’archivio');
  await fetch(`${base}/api/csv/${result.body.saved[0].id}`, { method: 'DELETE' });
});

test('archivio CSV: due file con lo stesso nome nello stesso secondo non si sovrascrivono', async (t) => {
  const { base } = server;
  await clearArchive(base);
  t.after(() => clearArchive(base));
  const gen = await fixture('valid', 'SYN_GEN_25.csv');
  const feb = await fixture('valid', 'SYN_FEB_25.csv');
  const result = await upload(base, [['GEN_25.csv', gen], ['GEN_25.csv', feb]]);
  assert.equal(result.body.saved.length, 2);
  assert.notEqual(result.body.saved[0].id, result.body.saved[1].id);
  const list = (await (await fetch(`${base}/api/csv/list`)).json()).files;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((item) => item.name), ['GEN_25.csv', 'GEN_25.csv']);
  const contents = await Promise.all(list.map(async (item) => (await fetch(`${base}/api/csv/${item.id}`)).text()));
  assert.deepEqual(contents, [gen, feb]);
  for (const item of list) await fetch(`${base}/api/csv/${item.id}`, { method: 'DELETE' });
});

test('isolamento: i CSV di un profilo non sono visibili né eliminabili da un altro', async () => {
  const { base } = server;
  const created = await (await fetch(`${base}/api/users`, json('POST', { name: 'Isolato' }))).json();
  const isolated = created.user.id;
  const saved = (await upload(base, [['ISO.csv', await fixture('valid', 'SYN_GEN_25.csv')]])).body.saved[0];
  await fetch(`${base}/api/users/switch`, json('POST', { userId: 'user-1' }));
  const list = (await (await fetch(`${base}/api/csv/list`)).json()).files;
  assert.equal(list.some((item) => item.id === saved.id), false);
  assert.equal((await fetch(`${base}/api/csv/${saved.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/csv/${saved.id}`, { method: 'DELETE' })).status, 404);
  await fetch(`${base}/api/users/${isolated}`, { method: 'DELETE' });
  assert.equal((await readdir(join(dataDir, 'csv'))).includes(isolated), false, 'eliminazione rimuove l’archivio del profilo');
});

test('feedback tipi sconosciuti: validazione payload e salvataggio locale senza esporre percorsi', async () => {
  const { base } = server;
  let response = await fetch(`${base}/api/feedback/unknown-types`, json('POST', { files: 'x' }));
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/feedback/unknown-types`, json('POST', {}));
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/feedback/unknown-types`, json('POST', { files: [{ name: 'a.csv', unknownTypes: [] }] }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.path, undefined, 'nessun percorso assoluto nella risposta');
  const saved = await readdir(join(dataDir, 'feedback'));
  assert.ok(saved.includes(body.fileName));
});

test('API sconosciute: 404 JSON anche in produzione', async () => {
  const response = await fetch(`${server.base}/api/non-esiste`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const page = await fetch(`${server.base}/`);
  assert.equal(page.status, 200, 'la pagina resta servita');
});

test('solo locale: nessun CORS aperto, origini e Host estranei rifiutati, niente form cross-site', async () => {
  const { base, port } = server;
  let response = await fetch(`${base}/api/csv/list`, { headers: { Origin: 'https://sito-esterno.example' } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);

  response = await fetch(`${base}/api/users`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://sito-esterno.example', 'Access-Control-Request-Method': 'DELETE' },
  });
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');

  response = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { Origin: 'https://sito-esterno.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=CSRF',
  });
  assert.equal(response.status, 403);
  response = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=SenzaOrigin',
  });
  assert.notEqual(response.status, 201, 'il corpo form-urlencoded non è più interpretato');

  assert.equal(await getWithHost(port, '/api/users', `attacker.example:${port}`), 403, 'protezione DNS rebinding');
  assert.equal(await getWithHost(port, '/api/users', `localhost:${port}`), 200, 'Host locale consentito');

  response = await fetch(`${base}/api/users`, { headers: { Origin: `http://localhost:${port}` } });
  assert.equal(response.status, 200, 'stessa origine consentita');
  response = await fetch(`${base}/api/users`, { headers: { Origin: 'http://127.0.0.1:5173' } });
  assert.equal(response.status, 200, 'origine loopback di Vite (npm run dev:ui) consentita');

  response = await fetch(`${base}/__shutdown`, { method: 'POST', headers: { Origin: 'https://sito-esterno.example' } });
  assert.equal(response.status, 403, 'arresto cross-site rifiutato');
});

test('il server ascolta solo su loopback per impostazione predefinita', async () => {
  assert.match(server.output(), /127\.0\.0\.1/);
});

test('users.json corrotto: errore esplicito, nessuna sovrascrittura silenziosa', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-api-corrupt-'));
  const corrupted = '{"currentUserId":"user-9","users":[{"id":"user-9"';
  await writeFile(join(dir, 'users.json'), corrupted);
  const local = await startServer(dir);
  try {
    const response = await fetch(`${local.base}/api/users`);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /users\.json/);
    assert.equal(await readFile(join(dir, 'users.json'), 'utf-8'), corrupted);
  } finally {
    await stopServer(local);
    await rm(dir, { recursive: true, force: true });
  }
});

test('recupero dopo riavvio e arresto locale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-api-restart-'));
  let local = await startServer(dir);
  try {
    await upload(local.base, [['A.csv', await fixture('valid', 'SYN_GEN_25.csv')]]);
    await new Promise((done) => setTimeout(done, 1100));
    await upload(local.base, [['B.csv', await fixture('valid', 'SYN_FEB_25.csv')]]);
    const before = (await (await fetch(`${local.base}/api/csv/list`)).json()).files.map((item) => item.id);
    const response = await fetch(`${local.base}/__shutdown`, { method: 'POST' });
    assert.equal(response.status, 202);
    await once(local.child, 'exit');
    local = await startServer(dir);
    const afterRestart = (await (await fetch(`${local.base}/api/csv/list`)).json()).files.map((item) => item.id);
    assert.deepEqual(afterRestart, before, 'stesso contenuto e stesso ordine dopo il riavvio');
  } finally {
    await stopServer(local);
    await rm(dir, { recursive: true, force: true });
  }
});
