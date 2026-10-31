import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { derivePortfolio, parseCsv } from '../src/js/portfolio-engine.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoCsvs = [
  `datetime,date,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,fx_rate,transaction_id,mcc_code
2026-10-20T09:00:00Z,2026-10-20,CASH,CUSTOMER_INBOUND,,,,,,10000,,,EUR,,demo-1-cash,
2026-10-20T10:00:00Z,2026-10-20,TRADING,BUY,FUND,Fondo Demo 1,IE000TEST0001,20,100,-2000,,,EUR,,demo-1-fund,
2026-10-20T11:00:00Z,2026-10-20,TRADING,BUY,STOCK,Azione Demo 1,US000TEST0001,10,100,-1000,,,EUR,,demo-1-stock,`,
  `datetime,date,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,fx_rate,transaction_id,mcc_code
2026-10-20T09:00:00Z,2026-10-20,CASH,CUSTOMER_INBOUND,,,,,,12000,,,EUR,,demo-2-cash,
2026-10-20T10:00:00Z,2026-10-20,TRADING,BUY,FUND,Fondo Demo 2,IE000TEST0002,30,100,-3000,,,EUR,,demo-2-fund,
2026-10-20T11:00:00Z,2026-10-20,TRADING,BUY,STOCK,Azione Demo 2,US000TEST0002,15,100,-1500,,,EUR,,demo-2-stock,`,
  `datetime,date,category,type,asset_class,name,symbol,shares,price,amount,fee,tax,currency,fx_rate,transaction_id,mcc_code
2026-10-20T09:00:00Z,2026-10-20,CASH,CUSTOMER_INBOUND,,,,,,15000,,,EUR,,demo-3-cash,
2026-10-20T10:00:00Z,2026-10-20,TRADING,BUY,FUND,Fondo Demo 3,IE000TEST0003,40,100,-4000,,,EUR,,demo-3-fund,
2026-10-20T11:00:00Z,2026-10-20,TRADING,BUY,STOCK,Azione Demo 3,US000TEST0003,20,100,-2000,,,EUR,,demo-3-stock,`,
];

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

async function requestJson(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

test('three users keep independent names and valid demo portfolios across switches', async () => {
  const dataDirectory = await mkdtemp(resolve(tmpdir(), 'portfolio-manager-users-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      PORTFOLIO_DATA_DIR: dataDirectory,
      PORTFOLIO_SKIP_PRICES: '1',
    },
    stdio: 'ignore',
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/users`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The server may need a moment to bind its test port.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(ready, true, 'server did not start');

    const initial = await requestJson(baseUrl, '/api/users');
    const users = [initial.body.users[0]];
    assert.equal(initial.body.users.length, 1);
    assert.equal(users[0].name, 'Utente Principale');

    for (const name of ['Utente Due', 'Utente Tre']) {
      const created = await requestJson(baseUrl, '/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.currentUserId, created.body.user.id);
      users.push(created.body.user);
    }

    const expectedNames = ['Principale Rinominate', 'Secondo Profilo', 'Terzo Profilo'];
    for (const [index, user] of users.entries()) {
      const switched = await requestJson(baseUrl, '/api/users/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      assert.equal(switched.body.currentUserId, user.id);

      const renamed = await requestJson(baseUrl, `/api/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: expectedNames[index] }),
      });
      assert.equal(renamed.response.status, 200);
      assert.equal(renamed.body.user.name, expectedNames[index]);

      const form = new FormData();
      form.append('files', new Blob([demoCsvs[index]], { type: 'text/csv' }), `utente-${index + 1}.csv`);
      const uploaded = await fetch(`${baseUrl}/api/csv/upload`, { method: 'POST', body: form });
      assert.equal(uploaded.status, 200);
      const uploadResult = await uploaded.json();
      assert.equal(uploadResult.saved.length, 1);
      const parsed = parseCsv(uploadResult.saved[0].content);
      assert.equal(parsed.errors.length, 0);
      assert.equal(parsed.rows.length, 3);
      const expectedTotals = [10000, 12000, 15000];
      const expectedCash = [7000, 7500, 9000];
      const expectedCore = [2000, 3000, 4000];
      const expectedSatellite = [1000, 1500, 2000];
      const portfolio = derivePortfolio([{
        id: uploadResult.saved[0].id,
        name: uploadResult.saved[0].name,
        content: uploadResult.saved[0].content,
      }], {
        assets: [
          {
            isin: `IE000TEST000${index + 1}`,
            name: `Fondo Demo ${index + 1}`,
            portfolio: 'CORE',
            targetWeight: expectedCore[index] / expectedTotals[index] * 100,
          },
          {
            isin: `US000TEST000${index + 1}`,
            name: `Azione Demo ${index + 1}`,
            portfolio: 'SATELLITE',
            targetWeight: expectedSatellite[index] / expectedTotals[index] * 100,
          },
        ],
        cryptoMap: {},
        mccRules: {},
        expensesOpening: 0,
        emergencyOpening: 0,
      });
      assert.equal(portfolio.groupedAssets.length, 2);
      assert.equal(portfolio.investmentCash, expectedCash[index]);
      assert.equal(portfolio.investmentsValue, expectedTotals[index]);
      assert.equal(portfolio.coreValue, expectedCore[index]);
      assert.equal(portfolio.satelliteValue, expectedSatellite[index]);
    }

    for (const [index, user] of users.entries()) {
      const switched = await requestJson(baseUrl, '/api/users/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      assert.equal(switched.body.currentUserId, user.id);

      const current = await requestJson(baseUrl, '/api/users');
      assert.equal(current.body.users.find(({ id }) => id === user.id).name, expectedNames[index]);
      assert.equal(current.body.currentUserId, user.id);

      const archive = await requestJson(baseUrl, '/api/csv/list');
      assert.deepEqual(archive.body.files.map(({ name }) => name), [`utente-${index + 1}.csv`]);
      const csvResponse = await fetch(`${baseUrl}/api/csv/${encodeURIComponent(archive.body.files[0].id)}`);
      assert.equal(csvResponse.status, 200);
      assert.equal(parseCsv(await csvResponse.text()).rows.length, 3);
    }

    const blankName = await requestJson(baseUrl, `/api/users/${users[0].id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    assert.equal(blankName.response.status, 400);

    const serverStopped = once(server, 'exit');
    const shutdown = await fetch(`${baseUrl}/__shutdown`, { method: 'POST' });
    assert.equal(shutdown.status, 202);
    assert.deepEqual(await shutdown.json(), { stopping: true });
    await serverStopped;
    assert.equal(server.exitCode, 0);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
