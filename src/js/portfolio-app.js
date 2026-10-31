import mccConfig from '../data/mcc_mapping.json';
import cryptoMap from '../data/crypto_isin_map.json';
import {
  buildAnnualBalanceReport,
  calculateRebalancingMetrics,
  derivePortfolio,
  formatCurrency,
  formatNumber,
  normalizeSectionWeights,
  parseCsv,
  parseLocaleNumber,
  reconcileLiquidityBalances,
  validateAllocationConfiguration,
} from './portfolio-engine.js';

const STORAGE_KEY = 'portfolio-manager-app-v1';
const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const settingsBody = document.getElementById('allocazione-tbody');
const csvBody = document.querySelector('#archive-pane-csv .csv-table tbody');
const overviewBody = document.querySelector('#panel-overview .allocation-table tbody');
const rebalanceBody = document.querySelector('#panel-rebalancing .rebalancing-table tbody');
const savingsCard = document.querySelector('.card.risparmi .card-value');
const emergencyCard = document.querySelector('.card.emergenze .card-value');
const totalAccount = document.querySelector('.total-account span:last-child');
const investmentHeader = document.querySelector('.card.investimenti .card-header span:last-child');
const investmentValues = [...document.querySelectorAll('.card.investimenti .investment-item span:last-child')];
const pdfList = document.querySelector('.pdf-list');
const mccRules = { ...mccConfig.mcc_rules };
const defaults = {
  version: 3,
  imports: [],
  assets: null,
  sectionWeights: null,
  risparmiOpening: 0,
  emergencyOpening: 0,
  thresholdA: 5,
  thresholdAP: 3,
  thresholdRelative: 0,
  minAmount: 0,
};
let state = { ...defaults };
let result = null;
let currentUser = null;
let users = [];
let csvStats = []; // Statistiche CSV inclusi unknownTypes

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

// Impostazioni comuni a tutte le chiamate di derivePortfolio (incluso il conto
// di default per gli MCC non mappati, definito in mcc_mapping.json).
function engineSettings(assets) {
  return {
    assets,
    cryptoMap,
    mccRules,
    defaultAccount: mccConfig.default_conto,
    risparmiOpening: state.risparmiOpening,
    emergencyOpening: state.emergencyOpening,
    // Prezzi estratti al caricamento di ciascun CSV, poi correzioni manuali: il CSV più recente prevale.
    priceOverrides: Object.assign({}, ...state.imports.map((file) => ({ ...file.prices, ...file.manualPrices }))),
  };
}

// Impostazioni, ordine dei CSV, saldi Risparmi/Emergenze e prezzi manuali:
// salvati sul server (server/data/state/<utente>.json), mai nel browser.
let serverState = {};
let saveChain = Promise.resolve();

function putState(key, value) {
  serverState[key] = value;
  saveChain = saveChain
    .then(async () => {
      const response = await fetch(`/api/state/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    })
    .catch((error) => {
      notify(`Impossibile salvare ${key} sul server: ${error.message}`);
      return false;
    });
  return saveChain;
}

// Una tantum riporta sul server i dati che versioni precedenti tenevano nel
// localStorage del browser, poi li elimina dal browser.
async function loadState() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    serverState = await response.json();
  } catch (error) {
    console.warn('Stato non caricabile dal server:', error.message);
    serverState = {};
  }
  const base = `${STORAGE_KEY}:${currentUser?.id}`;
  const legacyFallback = currentUser?.id === 'user-1' ? STORAGE_KEY : null;
  for (const [key, name, fallback] of [['settings', base, legacyFallback], ['imports', `${base}:imports`, null]]) {
    const raw = localStorage.getItem(name) ?? (fallback ? localStorage.getItem(fallback) : null);
    if (raw && !serverState[key]) {
      let saved = false;
      try {
        saved = await putState(key, JSON.parse(raw));
      } catch {
        // JSON corrotto: non migrabile, il dato resta nel browser
      }
      if (!saved) continue;
    }
    localStorage.removeItem(name);
    if (fallback) localStorage.removeItem(fallback);
  }
}

function persistImportMeta(imports = state.imports) {
  const balances = {};
  imports.forEach((file) => {
    const entry = {
      risparmi: file.risparmiBalance ?? null,
      emergency: file.emergencyBalance ?? null,
      prices: file.manualPrices,
    };
    if (entry.risparmi != null || entry.emergency != null || Object.keys(entry.prices ?? {}).length) {
      balances[file.id] = entry;
    }
  });
  putState('imports', {
    version: 2,
    order: imports.map((file) => file.id),
    balances,
  });
}

function applyImportMeta(imports) {
  const meta = serverState.imports ?? null;
  if (!meta || typeof meta !== 'object') return imports;
  const order = Array.isArray(meta.order) ? meta.order : [];
  const position = new Map(order.map((id, index) => [id, index]));
  const sorted = imports
    .map((file, index) => ({ file, rank: position.get(file.id) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ file }) => file);
  const legacyMeta = meta.version !== 2;
  sorted.forEach((file) => {
    const saved = meta.balances?.[file.id];
    if (!saved) return;
    if (legacyMeta) {
      const correnti = finiteOrNull(saved.correnti);
      const risparmi = finiteOrNull(saved.risparmi);
      file.risparmiBalance = correnti == null && risparmi == null
        ? null
        : (correnti ?? 0) + (risparmi ?? 0);
    } else {
      file.risparmiBalance = finiteOrNull(saved.risparmi);
    }
    file.emergencyBalance = finiteOrNull(saved.emergency);
    file.manualPrices = Object.fromEntries(Object.entries(saved.prices ?? {}).filter(([, price]) => price > 0));
  });
  if (legacyMeta) persistImportMeta(sorted);
  return sorted;
}

function conditionalAssetWeight(targetA, sectionWeight) {
  return sectionWeight > 0 ? number(targetA) / sectionWeight * 100 : 0;
}

function isValidStoredAllocation(assets, sectionWeights) {
  const sections = {};
  for (const portfolio of ['CORE', 'SATELLITE']) {
    sections[portfolio] = {
      targetWeight: number(sectionWeights?.[portfolio]),
      assetWeights: assets.filter((asset) => asset.portfolio === portfolio)
        .map((asset) => number(asset.targetWeight)),
    };
  }
  const cashTarget = number(sectionWeights?.CASH);
  sections.CASH = { targetWeight: cashTarget, assetWeights: cashTarget > 0 ? [cashTarget] : [] };
  return validateAllocationConfiguration(sections).valid;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function notify(message) {
  window.alert(message);
}

// Persiste solo le impostazioni utente (allocazione, soglie, saldi apertura) sul server.
// I CSV sono archiviati sul server via API
function persistSettings() {
  if (!validateCurrentAllocation()) return;
  putState('settings', {
    version: state.version,
    assets: state.assets,
    sectionWeights: state.sectionWeights,
    risparmiOpening: state.risparmiOpening,
    emergencyOpening: state.emergencyOpening,
    thresholdA: state.thresholdA,
    thresholdAP: state.thresholdAP,
    thresholdRelative: state.thresholdRelative,
    minAmount: state.minAmount,
  });
}

function restoreSettings() {
  const stored = serverState.settings;
  if (!stored) {
    state = { ...defaults, assets: [], imports: [] };
    return;
  }
  let parsed;
  try {
    parsed = stored;
    if (![1, 2, 3].includes(parsed.version)) throw new Error('versione non riconosciuta');
  } catch (error) {
    // Un valore corrotto non deve bloccare l'avvio dell'app.
    console.warn('Impostazioni salvate non leggibili:', error.message);
    notify('Le impostazioni salvate non sono leggibili: verranno usate quelle predefinite e ricalcolate dai CSV.');
    state = { ...defaults, assets: [], imports: [] };
    return;
  }
  if (parsed.version === 1 && Array.isArray(parsed.assets)) {
    parsed.assets = parsed.assets.map((asset) => ({
      ...asset,
      targetWeight: number(parsed.sectionWeights?.[asset.portfolio]) * number(asset.targetWeight) / 100,
    }));
  }
  let migratedBalances = false;
  if (parsed.correntiOpening !== undefined || parsed.expensesOpening !== undefined) {
    const legacyBalance = parsed.correntiOpening ?? parsed.expensesOpening;
    parsed.risparmiOpening = number(parsed.risparmiOpening) + number(legacyBalance);
    migratedBalances = true;
  }
  delete parsed.correntiOpening;
  delete parsed.expensesOpening;
  if (Array.isArray(parsed.assets) && !isValidStoredAllocation(parsed.assets, parsed.sectionWeights)) {
    parsed.assets = [];
    parsed.sectionWeights = null;
  }
  parsed.version = defaults.version;
  state = { ...defaults, ...parsed, imports: [] }; // imports sempre vuoto, si carica da server
  if (migratedBalances) persistSettings();
}

function clearPortfolio() {
  state = { ...defaults };
  state.assets = [];
  state.sectionWeights = { CORE: 0, SATELLITE: 0, CASH: 0 };
  result = null;
  csvBody.replaceChildren();
  overviewBody.replaceChildren();
  rebalanceBody.replaceChildren();
  pdfList.replaceChildren();
  totalAccount.textContent = formatCurrency(0);
  savingsCard.textContent = formatCurrency(0);
  emergencyCard.textContent = formatCurrency(0);
  investmentHeader.textContent = formatCurrency(0);
  investmentValues.forEach((element) => { element.textContent = formatCurrency(0); });
  renderSettings();
  persistSettings();
}

// User management
function getInitials(name) {
  return name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

async function loadUsers() {
  try {
    const response = await fetch('/api/users');
    if (!response.ok) throw new Error('Impossibile caricare utenti');
    const data = await response.json();
    users = data.users || [];
    currentUser = users.find(u => u.id === data.currentUserId) || users[0];
    return data;
  } catch (error) {
    console.error('Load users error:', error);
    users = [{ id: 'user-1', name: 'Utente Principale', createdAt: new Date().toISOString() }];
    currentUser = users[0];
    return { users, currentUserId: 'user-1' };
  }
}

async function switchUser(userId) {
  try {
    const response = await fetch('/api/users/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!response.ok) throw new Error('Cambio utente fallito');
    const data = await response.json();
    currentUser = users.find(u => u.id === data.currentUserId);
    return data;
  } catch (error) {
    notify(`Cambio utente non riuscito: ${error.message}`);
    throw error;
  }
}

async function createUser(name) {
  const response = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Creazione utente fallita');
  if (Array.isArray(data.users)) users = data.users;
  else if (data.user && !users.some((user) => user.id === data.user.id)) users.push(data.user);
  currentUser = data.user;
  return data;
}

async function deleteUser(userId) {
  try {
    const response = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Eliminazione utente fallita');
    }
    const data = await response.json();
    users = users.filter(u => u.id !== userId);
    currentUser = users.find(u => u.id === data.currentUserId);
    return data;
  } catch (error) {
    notify(`Eliminazione utente non riuscita: ${error.message}`);
    throw error;
  }
}

function renderUserDropdown() {
  const userNameEl = document.getElementById('current-user-name');
  const userListEl = document.getElementById('user-list');
  const userBtn = document.getElementById('btn-user');
  const dropdown = document.getElementById('user-dropdown');
  const nameInput = document.getElementById('user-name-input');

  if (!userNameEl || !userListEl || !currentUser) return;

  userNameEl.textContent = currentUser.name;
  if (nameInput) nameInput.value = currentUser.name;

  userListEl.innerHTML = users.map(user => `
    <div class="user-item ${user.id === currentUser.id ? 'active' : ''}" data-user-id="${user.id}" role="option" aria-selected="${user.id === currentUser.id}">
      <div class="user-avatar">${escapeHtml(getInitials(user.name))}</div>
      <div class="user-info">
        <div class="user-display-name">${escapeHtml(user.name)}</div>
      </div>
      <div class="user-actions">
        ${user.id !== currentUser.id ? `
          <button class="btn-user-action delete" data-action="delete" data-user-id="${user.id}" aria-label="Elimina ${escapeHtml(user.name)}" title="Elimina utente">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        ` : ''}
      </div>
    </div>
  `).join('');

  // Click su utente per switch
  userListEl.querySelectorAll('.user-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.btn-user-action')) return;
      const userId = item.dataset.userId;
      if (userId !== currentUser.id) {
        await switchUser(userId);
        closeUserDropdown();
        await reloadForCurrentUser();
      }
    });
  });

  // Delete user
  userListEl.querySelectorAll('.btn-user-action.delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const userId = btn.dataset.userId;
      const user = users.find(u => u.id === userId);
      if (!user) return;
      if (confirm(`Eliminare l'utente "${user.name}"? Tutti i suoi CSV e impostazioni saranno persi.`)) {
        await deleteUser(userId);
        closeUserDropdown();
        await reloadForCurrentUser();
      }
    });
  });
}

function closeUserDropdown() {
  const userContainer = document.getElementById('header-user');
  if (userContainer) userContainer.classList.remove('open');
}

function bindUserDropdown() {
  const userBtn = document.getElementById('btn-user');
  const dropdown = document.getElementById('user-dropdown');
  const addUserBtn = document.getElementById('btn-add-user');
  const createForm = document.getElementById('user-create-form');
  const createName = document.getElementById('new-user-name');
  const createStatus = document.getElementById('new-user-status');
  const saveUserBtn = document.getElementById('save-new-user');
  const cancelUserBtn = document.getElementById('cancel-new-user');

  if (!userBtn || !dropdown || !addUserBtn || !createForm || !createName || !createStatus || !saveUserBtn || !cancelUserBtn) return;

  userBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const container = document.getElementById('header-user');
    const isOpen = container.classList.toggle('open');
    if (isOpen) renderUserDropdown();
  });

  // Chiudi dropdown cliccando fuori
  document.addEventListener('click', (e) => {
    const container = document.getElementById('header-user');
    if (container && !container.contains(e.target)) {
      container.classList.remove('open');
    }
  });

  addUserBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    createForm.hidden = false;
    addUserBtn.hidden = true;
    createName.focus();
  });

  cancelUserBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    createForm.reset();
    createForm.hidden = true;
    addUserBtn.hidden = false;
    createStatus.textContent = '';
  });

  createForm.addEventListener('click', (event) => event.stopPropagation());
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = createName.value.trim();
    if (!name) {
      createStatus.textContent = 'Inserisci un nome.';
      createName.focus();
      return;
    }

    saveUserBtn.disabled = true;
    createStatus.textContent = '';
    try {
      await createUser(name);
      createForm.reset();
      createForm.hidden = true;
      addUserBtn.hidden = false;
      closeUserDropdown();
      await reloadForCurrentUser();
    } catch (error) {
      createStatus.textContent = error.message;
    } finally {
      saveUserBtn.disabled = false;
    }
  });
}

function bindUserSettings() {
  const form = document.getElementById('user-settings-form');
  const nameInput = document.getElementById('user-name-input');
  const status = document.getElementById('user-name-status');
  const saveButton = document.getElementById('user-name-save');
  if (!form || !nameInput || !status || !saveButton) return;

  nameInput.addEventListener('input', () => {
    status.textContent = '';
    status.classList.remove('error');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = 'Inserisci un nome.';
      status.classList.add('error');
      nameInput.focus();
      return;
    }
    if (!currentUser) return;

    saveButton.disabled = true;
    status.textContent = '';
    status.classList.remove('error');
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(currentUser.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Aggiornamento non riuscito');
      currentUser = data.user;
      users = users.map((user) => user.id === currentUser.id ? currentUser : user);
      status.textContent = 'Nome aggiornato.';
      renderUserDropdown();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    } finally {
      saveButton.disabled = false;
    }
  });
}

function renderThresholds() {
  document.getElementById('soglia-a').value = formatNumber(number(state.thresholdA), 1);
  document.getElementById('soglia-ap').value = formatNumber(number(state.thresholdAP), 1);
  document.getElementById('soglia-rel').value = formatNumber(number(state.thresholdRelative), 1);
  document.getElementById('soglia-min').value = formatNumber(number(state.minAmount), 2);
}

async function reloadForCurrentUser() {
  // Ricarica impostazioni per il nuovo utente
  await loadState();
  restoreSettings();
  // Ricarica CSV per il nuovo utente
  await loadArchivedCsvs();
  // Ricalcola tutto
  if (state.imports.length) calculate();
  else clearPortfolio();
  // Aggiorna UI (anche le soglie del profilo appena selezionato)
  renderThresholds();
  renderUserDropdown();
}

function readSettings() {
  const assets = [];
  let portfolio = null;
  const sectionWeights = {};
  for (const row of settingsBody.children) {
    if (row.classList.contains('section-row')) {
      portfolio = row.querySelector('.section-label')?.textContent.trim().toUpperCase() ?? null;
      const weight = row.querySelector('.section-weight-input');
      sectionWeights[portfolio] = weight ? parseLocaleNumber(weight.value) : 0;
      continue;
    }
    if (!row.classList.contains('asset-row') || !portfolio) continue;
    const inputs = row.querySelectorAll('.table-input');
    const name = inputs[0]?.value.trim() ?? '';
    const isin = inputs[1]?.value.trim().toUpperCase() ?? '';
    const target = inputs[3] ? parseLocaleNumber(inputs[3].value) : 0;
    if (!name || !isin) continue;
    if (portfolio === 'CASH') continue;
    assets.push({ isin, name, portfolio, targetWeight: target });
  }
  return { assets, sectionWeights };
}

function monthName(date) {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]}_${date.slice(2, 4)}`;
}

function periodForFile(file, lastDate) {
  const match = file.name.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|GEN|MAG|GIU|LUG|AGO|SET|OTT|DIC)[_-]?(\d{2}|\d{4})\b/i);
  if (match) return `${match[1].toUpperCase()}_${match[2].slice(-2)}`;
  return lastDate ? monthName(lastDate) : file.name.replace(/\.csv$/i, '');
}

// Crea un oggetto import dal file caricato (il contenuto viene letto dal server)
function createImportObject(file) {
  let lastDate = '';
  try {
    lastDate = file.content
      ? parseCsv(file.content).rows.reduce((latest, row) => row.date > latest ? row.date : latest, '')
      : '';
  } catch {
    // File non valido: l'errore viene mostrato nell'Archivio, gli altri file restano utilizzabili.
    lastDate = '';
  }
  return {
    id: file.id,              // ID dal server (nome file salvato)
    name: file.name,
    period: periodForFile(file, lastDate),
    content: file.content,    // contenuto per parsing immediato
    emergencyBalance: null,
    risparmiBalance: null,
    prices: file.prices?.prices ?? {},
    pricesAsOf: file.prices?.asOf ?? null,
    manualPrices: {},
  };
}

function currentPortfolioState() {
  const settings = state.assets
    ? { assets: state.assets, sectionWeights: state.sectionWeights ?? {} }
    : readSettings();
  state.assets = settings.assets;
  state.sectionWeights = settings.sectionWeights;
  return settings;
}

function seedAssetConfiguration(positions) {
  const positionsByPortfolio = { CORE: [], SATELLITE: [] };
  positions.forEach((position) => {
    const portfolio = ['FUND', 'BOND'].includes(position.assetClass) ? 'CORE' : 'SATELLITE';
    positionsByPortfolio[portfolio].push({ ...position, portfolio });
  });

  const assets = [];
  for (const portfolio of ['CORE', 'SATELLITE']) {
    const entries = positionsByPortfolio[portfolio];
    const totalValue = entries.reduce((sum, item) => sum + Math.max(0, item.marketValue), 0);
    entries.forEach((item, index) => {
      const conditionalWeight = totalValue > 0
        ? Math.round((Math.max(0, item.marketValue) / totalValue) * 100000) / 1000
        : 0;
      assets.push({
        isin: item.id,
        name: item.name,
        portfolio,
        targetWeight: index === entries.length - 1 && totalValue > 0
          ? Math.max(0, 100 - entries.slice(0, -1).reduce((sum, previous) =>
            sum + (Math.round((Math.max(0, previous.marketValue) / totalValue) * 100000) / 1000), 0))
          : conditionalWeight,
      });
    });
  }
  return assets;
}

// Aggiunge con target 0 gli asset detenuti non ancora configurati. Viene chiamata
// solo quando esiste già una configurazione (la prima configurazione è creata
// in calculate() da seedAssetConfiguration).
function ensureAssets(positions) {
  const { assets } = currentPortfolioState();
  const known = new Set(assets.map((asset) => asset.isin.toUpperCase()));
  for (const position of positions) {
    if (known.has(position.id.toUpperCase())) continue;
    const portfolio = ['FUND', 'BOND'].includes(position.assetClass) ? 'CORE' : 'SATELLITE';
    state.assets.push({ isin: position.id, name: position.name, portfolio, targetWeight: 0 });
    known.add(position.id.toUpperCase());
  }
}

function calculate() {
  if (!state.imports.length) {
    clearPortfolio();
    return;
  }

  // First pass: derive portfolio with NO assets to get raw positions with correct assetClass
  const firstPass = derivePortfolio(state.imports, engineSettings([]));

  const openPositions = firstPass.groupedAssets.filter((asset) => Math.abs(asset.shares) > 1e-10);

  // Calculate section weights from asset classes (not from portfolio assignment)
  const sectionWeights = normalizeSectionWeights({
    CORE: openPositions
      .filter((p) => ['FUND', 'BOND'].includes(p.assetClass))
      .reduce((sum, p) => sum + Math.max(0, p.marketValue), 0),
    SATELLITE: openPositions
      .filter((p) => !['FUND', 'BOND'].includes(p.assetClass))
      .reduce((sum, p) => sum + Math.max(0, p.marketValue), 0),
    CASH: firstPass.investmentCash,
  });

  // Seed assets if none configured
  const { assets: currentAssets } = currentPortfolioState();
  if (!currentAssets.length) {
    const seededAssets = seedAssetConfiguration(openPositions);
    for (const portfolio of ['CORE', 'SATELLITE']) {
      const sectionAssets = seededAssets.filter((a) => a.portfolio === portfolio);
      let assigned = 0;
      sectionAssets.forEach((asset, index) => {
        const targetWeight = index === sectionAssets.length - 1
          ? number(sectionWeights[portfolio]) - assigned
          : Math.round(number(sectionWeights[portfolio]) * asset.targetWeight) / 100;
        asset.targetWeight = targetWeight;
        assigned += targetWeight;
      });
    }
    state.assets = seededAssets;
    state.sectionWeights = sectionWeights;
  } else {
    state.sectionWeights ??= sectionWeights;
    // Handle any new assets from CSV that aren't configured yet
    ensureAssets(openPositions);
  }

  // Second pass: derive with configured assets
  result = derivePortfolio(state.imports, engineSettings(state.assets));

  applyAccountBalanceOverrides();
  renderImports();
  renderSettings();
  renderPortfolio();
  renderPdfList();
  persistSettings();
}

function applyAccountBalanceOverrides() {
  const risparmi = [...state.imports].reverse().find((item) => item.risparmiBalance != null);
  const emergency = [...state.imports].reverse().find((item) => item.emergencyBalance != null);
  result = reconcileLiquidityBalances(result, {
    risparmiBalance: risparmi?.risparmiBalance ?? 0,
    emergencyBalance: emergency?.emergencyBalance ?? null,
  });
}

function formatPercent(value, digits = 1) {
  return `${formatNumber(value, digits)}%`;
}

function makeDelta(value, digits = 1) {
  const span = document.createElement('span');
  const adjusted = Math.abs(value) < 0.05 ? 0 : value;
  span.className = `delta ${adjusted < 0 ? 'negative' : 'positive'}`;
  span.textContent = `${adjusted < 0 ? '- ' : '+ '}${formatNumber(Math.abs(adjusted), digits)}%`;
  return span;
}

function makeWeight(value, delta, className) {
  const wrapper = document.createElement('span');
  wrapper.className = className;
  wrapper.append(document.createTextNode(`${formatPercent(value)} `), makeDelta(delta));
  return wrapper;
}

function sectionRow(section, percent, delta, columns = 3) {
  const row = document.createElement('tr');
  row.className = `section-row ${section.toLowerCase()}-section`;
  const cell = document.createElement('td');
  cell.colSpan = columns;
  const fullWidth = document.createElement('div');
  fullWidth.className = 'section-full-width';
  const label = document.createElement('span');
  label.className = 'section-label';
  label.textContent = section;
  const weight = document.createElement('span');
  weight.className = 'section-weight';
  weight.append(document.createTextNode(`${formatPercent(percent)} `), makeDelta(delta));
  fullWidth.append(label, weight);
  cell.append(fullWidth);
  row.append(cell);
  return row;
}

function overviewAssetRow(asset, portfolioValue, investmentValue, sectionTarget, targetAp) {
  const row = document.createElement('tr');
  row.className = 'asset-row';
  const nameCell = document.createElement('td');
  nameCell.className = 'asset-name';
  nameCell.textContent = asset.name;
  const portfolioWeight = portfolioValue ? asset.marketValue / portfolioValue * 100 : 0;
  const targetA = sectionTarget * targetAp / 100;
  const actualA = investmentValue ? asset.marketValue / investmentValue * 100 : 0;
  const apCell = document.createElement('td');
  apCell.append(makeWeight(targetAp, portfolioWeight - targetAp, 'weight-ap'));
  const totalCell = document.createElement('td');
  totalCell.append(makeWeight(targetA, actualA - targetA, 'weight-a'));
  row.append(nameCell, apCell, totalCell);
  return row;
}

function rebalancingAssetRow(asset, portfolioValue, investmentValue, sectionTarget, targetAp) {
  const row = document.createElement('tr');
  row.className = 'asset-row';
  const metrics = calculateRebalancingMetrics({
    assetValue: asset.marketValue,
    portfolioValue,
    investmentValue,
    sectionTarget,
    targetWeight: targetAp,
    thresholdAP: number(state.thresholdAP),
    thresholdA: number(state.thresholdA),
    thresholdRelative: number(state.thresholdRelative),
    minAmount: number(state.minAmount),
  });
  const { deltaEuro, deltaAP: deltaAp, deltaA, status } = metrics;
  const statusClass = status === 'BUY' ? 'status-buy' : status === 'SELL' ? 'status-sell' : 'status-hold';
  const values = [
    asset.name,
    asset.identifier,
    formatCurrency(asset.marketValue),
    `${deltaAp < 0 ? '- ' : '+ '}${formatNumber(Math.abs(deltaAp), 1)}%`,
    `${deltaA < 0 ? '- ' : '+ '}${formatNumber(Math.abs(deltaA), 1)}%`,
  ];
  values.forEach((value, index) => {
    const cell = document.createElement('td');
    if (index === 0) {
      cell.className = 'asset-name';
      cell.title = asset.name;
    }
    if (index === 2) cell.textContent = value;
    else if (index === 3 || index === 4) cell.append(makeDelta(deltaAp === 0 && index === 3 ? 0 : index === 3 ? deltaAp : deltaA));
    else cell.textContent = value;
    row.append(cell);
  });
  const statusCell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `status-badge ${statusClass}`;
  badge.textContent = status;
  statusCell.append(badge);
  const deltaCell = document.createElement('td');
  const delta = document.createElement('span');
  delta.className = `delta ${deltaEuro < 0 ? 'negative' : 'positive'}`;
  delta.textContent = `${deltaEuro < 0 ? '- ' : '+ '}${formatCurrency(Math.abs(deltaEuro))}`;
  deltaCell.append(delta);
  const priceCell = document.createElement('td');
  if (asset.identifier !== '—') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'csv-input price-input';
    input.dataset.isin = asset.identifier;
    input.setAttribute('aria-label', `Prezzo ${asset.name}`);
    input.value = asset.price > 0 ? formatNumber(asset.price, 2) : '';
    priceCell.append(input);
  }
  row.append(statusCell, deltaCell, priceCell);
  return row;
}

function renderPortfolio() {
  totalAccount.textContent = formatCurrency(result.totalValue);
  savingsCard.textContent = formatCurrency(result.risparmiCash);
  emergencyCard.textContent = formatCurrency(result.emergencyCash);
  investmentHeader.textContent = formatCurrency(result.investmentsValue);
  investmentValues[0].textContent = formatCurrency(result.coreValue);
  investmentValues[1].textContent = formatCurrency(result.satelliteValue);
  investmentValues[2].textContent = formatCurrency(result.investmentCash);

  const investmentValue = result.investmentsValue;
  const portfolioValues = {
    CORE: result.coreValue,
    SATELLITE: result.satelliteValue,
    CASH: result.investmentCash,
  };
  const sectionTargets = state.sectionWeights ?? { CORE: 0, SATELLITE: 0, CASH: 100 };
  const orderedAssets = state.assets.map((setting) =>
    result.groupedAssets.find((asset) => asset.identifier.toUpperCase() === setting.isin.toUpperCase()) ?? {
      id: setting.isin,
      identifier: setting.isin,
      name: setting.name,
      displayName: setting.name,
      portfolio: setting.portfolio,
      shares: 0,
      price: 0,
      marketValue: 0,
    },
  );
  const groups = {
    CORE: orderedAssets.filter((asset) => asset.portfolio === 'CORE'),
    SATELLITE: orderedAssets.filter((asset) => asset.portfolio === 'SATELLITE'),
    CASH: [{
      id: 'EUR000000000',
      identifier: '—',
      name: 'Trade Republic Cash Account',
      portfolio: 'CASH',
      shares: 0,
      marketValue: result.investmentCash,
      targetWeight: 100,
    }],
  };
  const apTargets = new Map(state.assets.map((asset) => {
    const sectionWeight = number(sectionTargets[asset.portfolio]);
    return [
      asset.isin.toUpperCase(),
      conditionalAssetWeight(asset.targetWeight, sectionWeight),
    ];
  }));
  const overviewRows = [];
  const rebalanceRows = [];
  for (const section of ['CORE', 'SATELLITE', 'CASH']) {
    const target = number(sectionTargets[section]);
    const actual = investmentValue ? portfolioValues[section] / investmentValue * 100 : 0;
    overviewRows.push(sectionRow(section, actual, actual - target));
    const sectionAssets = groups[section];
    const sectionValue = portfolioValues[section];
    rebalanceRows.push(rebalancingSectionRow(section));
    sectionAssets.forEach((asset) => {
      const ap = section === 'CASH' ? 100 : number(apTargets.get(asset.identifier.toUpperCase()));
      overviewRows.push(overviewAssetRow(asset, sectionValue, investmentValue, target, ap));
      rebalanceRows.push(rebalancingAssetRow(asset, sectionValue, investmentValue, target, ap));
    });
  }
  overviewBody.replaceChildren(...overviewRows);
  rebalanceBody.replaceChildren(...rebalanceRows);
  validateCurrentAllocation();
}

function rebalancingSectionRow(section) {
  const row = document.createElement('tr');
  row.className = `section-row ${section.toLowerCase()}-section`;
  const cell = document.createElement('td');
  cell.colSpan = 8;
  const fullWidth = document.createElement('div');
  fullWidth.className = 'section-full-width';
  const label = document.createElement('span');
  label.className = 'section-label';
  label.textContent = section;
  fullWidth.append(label);
  cell.append(fullWidth);
  row.append(cell);
  return row;
}

function allocationTemplates() {
  const asset = document.createElement('tr');
  asset.className = 'asset-row';
  asset.setAttribute('draggable', 'false');
  asset.innerHTML = `<td class="drag-handle-cell"><span class="drag-handle" title="Trascina per spostare">⋮</span></td><td><input type="text" class="table-input text-left"></td><td><input type="text" class="table-input"></td><td><div class="cell-percent"><input type="text" class="table-input readonly" readonly><span class="symbol">%</span></div></td><td><div class="cell-percent"><input type="text" class="table-input"><span class="symbol">%</span></div></td><td class="actions-cell"><button type="button" class="btn-delete" title="Elimina asset" aria-label="Elimina asset">×</button></td>`;
  return {
    sections: Object.fromEntries([...settingsBody.querySelectorAll('.section-row')].map((row) => [
      row.querySelector('.section-label').textContent.trim().toUpperCase(),
      row.cloneNode(true),
    ])),
    asset,
    empty: settingsBody.querySelector('.empty-asset-row').cloneNode(true),
  };
}

function buildAllocationRow(asset, template, value = asset.targetWeight) {
  const row = template.cloneNode(true);
  row.setAttribute('draggable', 'false');
  const fields = row.querySelectorAll('.table-input');
  fields[0].value = asset.name;
  fields[1].value = asset.isin;
  const sectionWeight = number(state.sectionWeights?.[asset.portfolio]);
  fields[2].value = formatNumber(conditionalAssetWeight(value, sectionWeight), 1);
  fields[3].value = formatNumber(value, 1);
  return row;
}

function buildCashAllocationRow(template) {
  const cashTarget = number(state.sectionWeights?.CASH);
  return buildAllocationRow({
    name: 'Trade Republic Cash Account',
    isin: '—',
    targetWeight: cashTarget,
    portfolio: 'CASH',
  }, template, cashTarget);
}

function renderSettings() {
  const templates = allocationTemplates();
  const rows = [];
  for (const section of ['CORE', 'SATELLITE', 'CASH']) {
    const sectionRowClone = templates.sections[section];
    const sectionInput = sectionRowClone.querySelector('.section-weight-input');
    if (sectionInput) sectionInput.value = formatNumber(number(state.sectionWeights?.[section]), 1);
    rows.push(sectionRowClone);
    if (section === 'CASH' && state.imports.length) {
      rows.push(buildCashAllocationRow(templates.asset));
    } else if (section !== 'CASH') {
      state.assets.filter((asset) => asset.portfolio === section).forEach((asset) => {
        rows.push(buildAllocationRow(asset, templates.asset));
      });
    }
    rows.push(templates.empty.cloneNode(true));
  }
  settingsBody.replaceChildren(...rows);
  validateCurrentAllocation();
}

function validateCurrentAllocation() {
  const settingsButton = document.getElementById('btn-settings');
  const allocationTab = document.querySelector('.sidebar-nav-item[data-target="pane-allocazione"]');
  if (!state.imports.length) {
    settingsButton.classList.remove('has-error');
    settingsButton.title = 'Impostazioni';
    allocationTab?.classList.remove('has-error');
    allocationTab?.removeAttribute('title');
    settingsBody.querySelectorAll('.distribution-valid, .distribution-invalid, .weight-valid, .weight-invalid')
      .forEach((input) => input.classList.remove(
        'distribution-valid',
        'distribution-invalid',
        'weight-valid',
        'weight-invalid',
      ));
    settingsBody.querySelectorAll('.table-input, .section-weight-input').forEach((input) => {
      input.removeAttribute('title');
    });
    return true;
  }
  const sections = new Map();
  let currentSection = null;
  for (const row of settingsBody.children) {
    if (row.classList.contains('section-row')) {
      currentSection = row.querySelector('.section-label')?.textContent.trim().toUpperCase() ?? '';
      sections.set(currentSection, { target: parseLocaleNumber(row.querySelector('.section-weight-input')?.value), sum: 0, rows: [] });
    } else if (row.classList.contains('asset-row') && currentSection) {
      const data = sections.get(currentSection);
      const input = row.querySelector('.cell-percent .table-input:not(.readonly)');
      const weight = parseLocaleNumber(input?.value);
      data.sum += weight;
      data.rows.push(input);
      const totalInput = row.querySelector('.cell-percent .table-input.readonly');
      const sectionInput = settingsBody.querySelector(`.section-row.${currentSection.toLowerCase()}-section .section-weight-input`);
      if (totalInput && sectionInput) {
        const sectionWeight = parseLocaleNumber(sectionInput.value);
        totalInput.value = formatNumber(conditionalAssetWeight(weight, sectionWeight), 1);
      }
    }
  }
  const allocation = validateAllocationConfiguration(Object.fromEntries(
    [...sections].map(([portfolio, data]) => [portfolio, {
      targetWeight: data.target,
      assetWeights: data.rows.map((input) => parseLocaleNumber(input?.value)),
    }]),
  ));
  sections.forEach((data, portfolio) => {
    const sectionValid = allocation.sections.find((item) => item.portfolio === portfolio)?.distributionValid ?? false;
    data.rows.forEach((input) => {
      input?.classList.toggle('distribution-valid', sectionValid);
      input?.classList.toggle('distribution-invalid', !sectionValid);
      if (input) {
        input.title = sectionValid
          ? ''
          : `${portfolio}: le percentuali (A) degli asset sommano ${formatNumber(data.sum, 1)}%; devono totalizzare ${formatNumber(data.target, 1)}%.`;
      }
    });
  });
  const totalValid = allocation.sectionWeightsValid && allocation.sectionWeightsInRange;
  document.querySelectorAll('.section-weight-input').forEach((input) => {
    input.classList.toggle('weight-valid', totalValid);
    input.classList.toggle('weight-invalid', !totalValid);
    input.title = totalValid
      ? ''
      : !allocation.sectionWeightsInRange
        ? 'Ogni percentuale di sezione deve essere compresa tra 0% e 100%.'
        : `Le percentuali delle sezioni sommano ${formatNumber(allocation.sectionWeightSum, 1)}%; devono totalizzare 100%.`;
  });
  settingsButton.classList.toggle('has-error', !allocation.valid);
  settingsButton.title = allocation.valid
    ? 'Impostazioni'
    : `Allocazione non valida: ${allocation.sections.filter((item) => !item.distributionValid)
      .map((item) => `${item.portfolio} ${formatNumber(item.assetWeightSum, 1)}% (atteso ${formatNumber(item.targetWeight, 1)}%)`)
      .concat(totalValid ? [] : `sezioni ${formatNumber(allocation.sectionWeightSum, 1)}% (atteso 100%)`)
      .join('; ')}.`;
  allocationTab?.classList.toggle('has-error', !allocation.valid);
  if (allocationTab) {
    if (allocation.valid) allocationTab.removeAttribute('title');
    else allocationTab.title = settingsButton.title;
  }
  return allocation.valid;
}

function constrainAllocationInput(input) {
  if (!input.matches('.section-weight-input, .cell-percent .table-input:not(.readonly)')) return;
  const value = parseLocaleNumber(input.value);
  let maximum = 100;
  if (!input.classList.contains('section-weight-input')) {
    let sectionRow = input.closest('.asset-row')?.previousElementSibling;
    while (sectionRow && !sectionRow.classList.contains('section-row')) {
      sectionRow = sectionRow.previousElementSibling;
    }
    const sectionWeight = sectionRow?.querySelector('.section-weight-input');
    maximum = Math.max(0, parseLocaleNumber(sectionWeight?.value));
  }
  input.value = formatNumber(Math.min(maximum, Math.max(0, value)), 1);
}

function renderImports() {
  const rows = [];
  state.imports.forEach((file, index) => {
    const row = document.createElement('tr');
    row.className = 'asset-row';
    row.dataset.importId = file.id;
    row.setAttribute('draggable', 'false');
    const risparmiValue = file.risparmiBalance != null ? `${formatNumber(file.risparmiBalance, 2)} €` : '';
    const emergencyValue = file.emergencyBalance != null ? `${formatNumber(file.emergencyBalance, 2)} €` : '';
    row.innerHTML = `<td class="drag-handle-cell"><span class="drag-handle" title="Trascina per spostare">⋮</span></td><td class="csv-filename">${escapeHtml(file.period)}.csv${file.pricesAsOf ? `<br><small title="Prezzi estratti al caricamento">prezzi al ${escapeHtml(file.pricesAsOf.split('-').reverse().join('-'))}</small>` : ''}</td><td><input type="text" class="csv-input" value="${risparmiValue}" aria-label="Risparmi"></td><td><input type="text" class="csv-input" value="${emergencyValue}" aria-label="Emergenze"></td><td class="actions-cell"><button type="button" class="btn-delete" title="Elimina CSV" aria-label="Elimina CSV ${escapeHtml(file.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button></td>`;
    row.dataset.importIndex = String(index);
    rows.push(row);

    // Riga errore inline espandibile sotto il CSV
    const stat = csvStats.find(s => s.id === file.id);
    if (stat && (stat.unknownTypes?.length || stat.invalid || stat.error)) {
      const errorRow = document.createElement('tr');
      errorRow.className = 'csv-error-row';
      errorRow.dataset.importId = file.id;

      const hasUnknownTypes = Boolean(stat.unknownTypes?.length);
      const errorTitle = hasUnknownTypes ? 'TRANSAZIONI NON RICONOSCIUTE' : 'ERRORI NEL CSV';
      const reportLines = [
        `File: ${file.name}`,
        errorTitle,
        stat.message || stat.error || 'Il file contiene righe non valide.',
      ];
      if (hasUnknownTypes) {
        reportLines.push('', ...(stat.unknownTypes || []).flatMap((unknownType) => [
          `  • ${unknownType.type} — ${unknownType.count} occorrenze`,
          ...(unknownType.sampleRows || []).map((sample) => `    • Riga ${sample.rowNumber}: type="${sample.type}", datetime="${sample.datetime}"`),
        ]));
      }
      const fullReport = reportLines.join('\n');

      errorRow.innerHTML = `
        <td colspan="5">
          <div class="csv-error-bar">
            <span class="csv-error-icon">⚠</span>
            <span class="csv-error-title">${errorTitle}</span>
            <button type="button" class="csv-error-expand" aria-label="Espandi dettagli errore" title="Espandi dettagli errore" aria-expanded="false">▼</button>
            <button type="button" class="csv-error-copy" aria-label="Copia errore" title="Copia errore negli appunti">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
          <div class="csv-error-details" style="display:none;">
            <pre>${escapeHtml(fullReport)}</pre>
          </div>
        </td>
      `;
      rows.push(errorRow);
    }
  });
  csvBody.replaceChildren(...rows);
  // Aggiorna indicatori di errore dopo il render
  updateErrorIndicators();
}

function renderPdfList() {
  const currentYear = new Date().getFullYear();
  const years = [...new Set(result.transactions.map((row) => row.date.slice(0, 4)))]
    .filter((year) => Number(year) < currentYear)
    .sort()
    .reverse();
  pdfList.replaceChildren(...years.map((year) => {
    const item = document.createElement('li');
    item.className = 'pdf-item';
    item.innerHTML = `<span class="pdf-icon">📄</span><span class="pdf-name">GM_${year.slice(-2)}.pdf</span><span class="pdf-date">${year}</span><button class="btn-open-pdf" aria-label="Apri PDF Giacenza Media ${year}" title="Apri PDF" data-pdf-year="${year}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10.588m0 0l3.292 3.292m-3.292-3.292L9.125 17.292"></path><polyline points="9 10 12 13 15 10"></polyline></svg></button>`;
    return item;
  }));
}

function updateComputedValues() {
  const previous = currentPortfolioState();
  result = derivePortfolio(state.imports, engineSettings(previous.assets));
  applyAccountBalanceOverrides();
  renderPortfolio();
  renderPdfList();
  persistSettings();
}

function bindUpload() {
  const button = document.querySelector('#archive-pane-csv .btn-upload');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.multiple = true;
  input.hidden = true;
  input.addEventListener('change', async () => {
    const selected = [...input.files];
    if (!selected.length) return;
    try {
      // Upload al server
      const formData = new FormData();
      selected.forEach(file => formData.append('files', file));
      const response = await fetch('/api/csv/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload fallito');

      const pending = (data.saved || []).map(file => createImportObject(file));
      const errors = data.errors || [];
      const details = [];

      if (pending.length) {
        if (!state.imports.length && state.assets === null) {
          state.assets = [];
          state.sectionWeights = null;
        }
        state.imports.push(...pending);
        calculate();
        persistImportMeta();

        const newImportIds = new Set(pending.map((file) => file.id));
        const newImportStats = result.importStats.filter((item) => newImportIds.has(item.id));
        const operationCount = newImportStats.reduce((sum, item) => sum + item.count, 0);
        const duplicateCount = newImportStats.reduce((sum, item) => sum + (item.duplicates ?? 0), 0);
        const invalidCount = newImportStats.reduce((sum, item) => sum + item.invalid, 0);
        details.push(
          `${pending.length} file importati`,
          `${operationCount} ${operationCount === 1 ? 'operazione valida' : 'operazioni valide'}`,
          `${duplicateCount} duplicati ignorati`,
          `${invalidCount} righe non valide ignorate`,
        );
      } else {
        details.push('Nessun file importato');
      }
      if (errors.length) details.push(`${errors.length} file rifiutati: ${errors.map(e => `${e.file}: ${e.error}`).join(' · ')}`);
      notify(details.join(' · '));
      // Ricarica statistiche CSV
      await loadCsvStats();
    } catch (error) {
      notify(`Importazione CSV non riuscita: ${error.message}`);
    } finally {
      input.value = '';
    }
  });
  document.body.append(input);
  button.addEventListener('click', () => input.click());
}

function bindImportTable() {
  csvBody.addEventListener('click', async (event) => {
    // Espandi / collassa dettagli errore
    const expandBtn = event.target.closest('.csv-error-expand');
    if (expandBtn) {
      const errorRow = expandBtn.closest('.csv-error-row');
      const details = errorRow.querySelector('.csv-error-details');
      const isHidden = details.style.display === 'none';
      details.style.display = isHidden ? 'block' : 'none';
      expandBtn.textContent = isHidden ? '▲' : '▼';
      expandBtn.setAttribute('aria-expanded', String(isHidden));
      return;
    }

    // Copia errore negli appunti
    const copyBtn = event.target.closest('.csv-error-copy');
    if (copyBtn) {
      const errorRow = copyBtn.closest('.csv-error-row');
      const pre = errorRow.querySelector('.csv-error-details pre');
      const text = pre ? pre.textContent : '';
      const originalContent = copyBtn.innerHTML;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.classList.add('copied');
        copyBtn.textContent = 'Copiato!';
        copyBtn.title = 'Copiato!';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = originalContent;
          copyBtn.title = 'Copia errore negli appunti';
        }, 1200);
      } catch (err) {
        console.warn('Copia fallita:', err);
        notify('Impossibile copiare negli appunti.');
      }
      return;
    }

    const button = event.target.closest('.btn-delete');
    if (!button) return;
    const row = button.closest('[data-import-id]');
    if (!row) return;
    const importId = row.dataset.importId;
    const fileName = state.imports.find((file) => file.id === importId)?.name ?? '';
    if (!confirm(`Eliminare il file "${fileName}" dall'archivio?`)) return;

    try {
      const response = await fetch(`/api/csv/${importId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Eliminazione fallita');
      state.imports = state.imports.filter((file) => file.id !== importId);
      persistImportMeta();
      if (state.imports.length) calculate();
      else clearPortfolio();
      // Ricarica statistiche CSV
      await loadCsvStats();
    } catch (error) {
      notify(`Eliminazione non riuscita: ${error.message}`);
    }
  });
  csvBody.addEventListener('change', (event) => {
    if (!event.target.matches('.csv-input')) return;
    const row = event.target.closest('[data-import-id]');
    const index = state.imports.findIndex((file) => file.id === row?.dataset.importId);
    if (index < 0) return;
    // L'evento arriva dall'<input>: la colonna è quella della cella che lo contiene.
    const raw = event.target.value.replace(/[^\d,.-]/g, '');
    const value = raw === '' ? null : parseLocaleNumber(raw);
    if (event.target.getAttribute('aria-label') === 'Risparmi') {
      state.imports[index].risparmiBalance = value;
    } else if (event.target.getAttribute('aria-label') === 'Emergenze') {
      state.imports[index].emergencyBalance = value;
    }
    persistImportMeta();
    updateComputedValues();
  });
  // Il prezzo digitato viene salvato nel CSV più recente.
  rebalanceBody.addEventListener('change', (event) => {
    if (!event.target.matches('.price-input') || !state.imports.length) return;
    const price = parseLocaleNumber(event.target.value.replace(/[^\d,.-]/g, ''));
    const latest = state.imports.at(-1);
    latest.manualPrices ??= {};
    if (price > 0) latest.manualPrices[event.target.dataset.isin] = price;
    else delete latest.manualPrices[event.target.dataset.isin];
    persistImportMeta();
    calculate();
  });
  csvBody.addEventListener('portfolio:reorder', () => {
    const ids = [...csvBody.querySelectorAll('[data-import-id]')].map((row) => row.dataset.importId);
    state.imports.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    persistImportMeta();
    calculate();
  });
}

function bindSettings() {
  settingsBody.addEventListener('input', (event) => {
    if (!event.target.matches('.table-input, .section-weight-input, .empty-input')) return;
    const allocationValid = validateCurrentAllocation();
    state.assets = readSettings().assets;
    state.sectionWeights = readSettings().sectionWeights;
    if (!allocationValid) return;
    updateComputedValuesIfImported();
    persistSettings();
  });
  settingsBody.addEventListener('change', (event) => {
    if (!event.target.matches('.table-input, .section-weight-input, .empty-input')) return;
    const row = event.target.closest('.empty-asset-row');
    if (row) addAssetFromEmptyRow(row);
    else {
      constrainAllocationInput(event.target);
      state.assets = readSettings().assets;
      state.sectionWeights = readSettings().sectionWeights;
      if (!validateCurrentAllocation()) return;
      updateComputedValuesIfImported();
      persistSettings();
    }
  });
  settingsBody.addEventListener('click', (event) => {
    const button = event.target.closest('.btn-delete');
    if (!button) return;
    const row = button.closest('.asset-row');
    const name = row?.querySelector('.text-left')?.value ?? 'questo asset';
    if (!row || !confirm(`Sei sicuro di voler eliminare "${name}"?`)) return;
    row.remove();
    state.assets = readSettings().assets;
    state.sectionWeights = readSettings().sectionWeights;
    updateComputedValuesIfImported();
    persistSettings();
    validateCurrentAllocation();
  });
  settingsBody.addEventListener('portfolio:reorder', () => {
    state.assets = readSettings().assets;
    state.sectionWeights = readSettings().sectionWeights;
    updateComputedValuesIfImported();
    persistSettings();
  });

  document.getElementById('soglia-a').addEventListener('input', (event) => {
    state.thresholdA = Math.max(0, parseLocaleNumber(event.target.value));
    updateComputedValuesIfImported();
    persistSettings();
  });
  document.getElementById('soglia-ap').addEventListener('input', (event) => {
    state.thresholdAP = Math.max(0, parseLocaleNumber(event.target.value));
    updateComputedValuesIfImported();
    persistSettings();
  });
  document.getElementById('soglia-rel').addEventListener('input', (event) => {
    state.thresholdRelative = Math.max(0, parseLocaleNumber(event.target.value));
    updateComputedValuesIfImported();
    persistSettings();
  });
  document.getElementById('soglia-min').addEventListener('input', (event) => {
    state.minAmount = Math.max(0, parseLocaleNumber(event.target.value));
    updateComputedValuesIfImported();
    persistSettings();
  });
}

function updateComputedValuesIfImported() {
  if (state.imports.length) updateComputedValues();
}

function addAssetFromEmptyRow(row) {
  const name = row.querySelector('.empty-input.text-left')?.value.trim() ?? '';
  const isin = row.querySelectorAll('.empty-input')[1]?.value.trim().toUpperCase() ?? '';
  const percent = row.querySelectorAll('.empty-input')[2];
  if (!name && !isin) return;
  if (!name || !isin) return;
  if (state.imports.length && (state.assets ?? []).some((asset) => asset.isin.toUpperCase() === isin)) {
    notify(`L’ISIN ${isin} è già presente.`);
    return;
  }
  const section = row.previousElementSibling;
  let parentSection = section;
  while (parentSection && !parentSection.classList.contains('section-row')) {
    parentSection = parentSection.previousElementSibling;
  }
  const portfolio = parentSection?.querySelector('.section-label')?.textContent.trim().toUpperCase();
  const template = allocationTemplates().asset;
  if (!portfolio) return;
  const sectionWeight = number(state.sectionWeights?.[portfolio]);
  const targetWeight = Math.min(sectionWeight, Math.max(0, parseLocaleNumber(percent?.value)));
  const asset = { isin, name, portfolio, targetWeight };
  const created = buildAllocationRow(asset, template, asset.targetWeight);
  settingsBody.insertBefore(created, row);
  row.querySelectorAll('.empty-input').forEach((input) => { input.value = ''; });
  state.assets = readSettings().assets;
  state.sectionWeights = readSettings().sectionWeights;
  if (state.imports.length) {
    updateComputedValues();
  } else persistSettings();
  validateCurrentAllocation();
}

function bindPdfDownloads() {
  pdfList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pdf-year]');
    if (!button) return;
    const year = Number(button.dataset.pdfYear);
    downloadAverageBalancePdf(year);
  });
}

function downloadAverageBalancePdf(year) {
  const report = result && buildAnnualBalanceReport(result, year);
  if (!report?.valid) {
    notify(report?.reason ?? `Non ci sono operazioni CSV per il ${year}.`);
    return;
  }
  const blob = new Blob([createAnnualReportPdf(report)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `GM_${String(year).slice(-2)}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createAnnualReportPdf(report) {
  const commands = [];
  const fillRect = (x, y, width, height, color) => {
    commands.push(`${color.join(' ')} rg ${x} ${y} ${width} ${height} re f`);
  };
  const strokeLine = (x1, y1, x2, y2, color, lineWidth = 1) => {
    commands.push(`${lineWidth} w ${color.join(' ')} RG ${x1} ${y1} m ${x2} ${y2} l S`);
  };
  const text = (value, x, y, size, font = 'F1', color = [0.10, 0.15, 0.22]) => {
    commands.push(`BT ${color.join(' ')} rg /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(value)}) Tj ET`);
  };
  const rightText = (value, right, y, size, font = 'F2', color = [0.10, 0.15, 0.22]) => {
    const safe = pdfText(value);
    text(value, right - safe.length * size * 0.52, y, size, font, color);
  };
  const navy = [0.055, 0.11, 0.18];
  const teal = [0.0, 0.56, 0.45];
  const muted = [0.39, 0.45, 0.52];
  const pale = [0.95, 0.97, 0.98];
  const line = [0.86, 0.89, 0.92];
  fillRect(0, 0, 595, 842, [1, 1, 1]);
  fillRect(0, 692, 595, 150, navy);
  fillRect(50, 808, 38, 4, teal);
  text('PORTFOLIO MANAGER', 50, 786, 9, 'F2', [0.73, 0.82, 0.87]);
  text('Giacenza media', 50, 746, 25, 'F2', [1, 1, 1]);
  text('Liquidita complessiva - report annuale', 50, 721, 11, 'F1', [0.77, 0.84, 0.89]);
  fillRect(482, 742, 63, 34, teal);
  text(String(report.year), 495, 754, 15, 'F2', [1, 1, 1]);

  const cards = [
    { x: 50, label: 'GIACENZA MEDIA LIQUIDITA COMPLESSIVA', value: formatCurrency(report.averageLiquidity) },
    { x: 220, label: 'CONTO TITOLI AL 31/12', value: formatCurrency(report.securitiesClosing) },
    { x: 390, label: 'LIQUIDITA AL 31/12', value: formatCurrency(report.liquidityClosing) },
  ];
  cards.forEach((card) => {
    fillRect(card.x, 556, 155, 112, pale);
    fillRect(card.x, 556, 155, 3, teal);
    text(card.label, card.x + 12, 644, 6.5, 'F2', muted);
    text(card.value.replace(/\s?€/, ''), card.x + 12, 601, 14, 'F2', navy);
    text('EUR', card.x + 12, 579, 8, 'F1', muted);
  });

  text('CRITERI DI CALCOLO', 50, 510, 9, 'F2', navy);
  strokeLine(50, 497, 545, 497, line);
  const rows = [
    ['Periodo della media', `01/01/${report.year} - 31/12/${report.year}`],
    ['Giorni inclusi', String(report.days)],
    ['Liquidita giornaliera', 'Somma dei flussi di cassa aggregati dai CSV'],
    ['Valore titoli', "Quote al 31/12 x ultimo prezzo CSV disponibile nell'anno"],
  ];
  rows.forEach(([label, value], index) => {
    const y = 468 - index * 34;
    if (index % 2 === 0) fillRect(50, y - 9, 495, 27, [0.975, 0.98, 0.985]);
    text(label, 62, y, 9, 'F1', muted);
    rightText(value, 533, y, 8.5, 'F1', navy);
  });

  fillRect(50, 292, 495, 50, [0.91, 0.97, 0.95]);
  fillRect(50, 292, 3, 50, teal);
  text('REPORT ELABORATO DAI FILE CSV IMPORTATI', 64, 322, 8, 'F2', teal);
  text('Non sono state utilizzate quotazioni o saldi iniziali esterni.', 64, 304, 8.5, 'F1', navy);
  strokeLine(50, 60, 545, 60, line);
  text("Documento di sintesi generato localmente dall'applicazione.", 50, 43, 8, 'F1', muted);
  rightText(`Creato il ${new Date().toLocaleDateString('it-IT')}`, 545, 43, 8, 'F1', muted);
  const stream = `${commands.join('\n')}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

function pdfText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/€/g, 'EUR')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\()]/g, '\\$&');
}

// Carica la lista CSV archiviati dal server all'avvio
async function loadArchivedCsvs() {
  try {
    const response = await fetch('/api/csv/list');
    if (!response.ok) throw new Error('Impossibile caricare archivio CSV');
    const data = await response.json();
    
    // Per ogni file, scarica il contenuto
    const filesWithContent = await Promise.all(
      (data.files || []).map(async (file) => {
        try {
          const contentResponse = await fetch(`/api/csv/${file.id}`);
          if (contentResponse.ok) {
            const content = await contentResponse.text();
            return { ...file, content };
          }
        } catch (e) {
          console.warn(`Impossibile caricare contenuto per ${file.id}:`, e.message);
        }
        return file;
      })
    );
    
    state.imports = applyImportMeta(filesWithContent.map(file => createImportObject(file)));
    
    // Carica statistiche CSV
    await loadCsvStats();
  } catch (error) {
    console.warn('Caricamento archivio CSV fallito:', error.message);
    state.imports = [];
  }
}

// Carica statistiche CSV dal server
async function loadCsvStats() {
  try {
    const response = await fetch('/api/csv/stats');
    if (!response.ok) throw new Error('Impossibile caricare statistiche CSV');
    const data = await response.json();
    csvStats = data.stats || [];
  } catch (error) {
    console.warn('Caricamento statistiche CSV fallito:', error.message);
    csvStats = [];
  }
  // Le righe di dettaglio errori dipendono dalle statistiche appena caricate.
  if (state.imports.length) renderImports();
  else updateErrorIndicators();
}

// Aggiorna gli indicatori di errore (punto esclamativo rosso) per CSV con tipi sconosciuti
function updateErrorIndicators() {
  const filesWithUnknownTypes = csvStats.filter(stat => stat.unknownTypes && stat.unknownTypes.length > 0);
  const hasAnyUnknownTypes = filesWithUnknownTypes.length > 0;
  const affectedFileIds = new Set(filesWithUnknownTypes.map(f => f.id));

  // 1. Archive button in header
  const archiveBtn = document.getElementById('btn-archive');
  if (archiveBtn) {
    archiveBtn.classList.toggle('has-error', hasAnyUnknownTypes);
  }

  // 2. CSV sidebar nav item
  const csvNavItem = document.querySelector('.sidebar-nav-item[data-target="archive-pane-csv"]');
  if (csvNavItem) {
    csvNavItem.classList.toggle('has-error', hasAnyUnknownTypes);
  }

  // 3. CSV files in the archive table
  document.querySelectorAll('#archive-pane-csv .csv-table tbody tr[data-import-id]').forEach(row => {
    const importId = row.dataset.importId;
    const isAffected = affectedFileIds.has(importId);
    const filenameCell = row.querySelector('.csv-filename');
    if (filenameCell) {
      // Remove existing indicator if any
      const existingIndicator = filenameCell.querySelector('.validation-error');
      if (existingIndicator) existingIndicator.remove();
      
      if (isAffected) {
        const indicator = document.createElement('span');
        indicator.className = 'validation-error';
        indicator.title = 'Questo CSV contiene tipi di transazione non riconosciuti';
        indicator.textContent = '!';
        filenameCell.appendChild(indicator);
      }
    }
  });
}

export async function initPortfolioApp() {
  try {
    await loadUsers();
    await loadState();
    restoreSettings();
    await loadArchivedCsvs();
    bindUpload();
    bindImportTable();
    bindSettings();
    bindPdfDownloads();
    bindUserDropdown();
    bindUserSettings();
    if (state.imports.length) calculate();
    else clearPortfolio();
    renderThresholds();
    renderUserDropdown();
  } catch (error) {
    notify(`Avvio dell'app non riuscito: ${error.message}`);
  }
}
