export const REQUIRED_COLUMNS = [
  'datetime', 'date', 'category', 'type', 'asset_class', 'name', 'symbol',
  'shares', 'price', 'amount', 'fee', 'tax', 'currency', 'fx_rate',
  'transaction_id', 'mcc_code',
];

const CATEGORIES_BY_TYPE = {
  BUY: 'TRADING',
  SELL: 'TRADING',
  MIGRATION: 'DELIVERY',
  CUSTOMER_INBOUND: 'CASH',
  CUSTOMER_OUTBOUND_REQUEST: 'CASH',
  TRANSFER_INBOUND: 'CASH',
  TRANSFER_OUTBOUND: 'CASH',
  TRANSFER_INSTANT_INBOUND: 'CASH',
  TRANSFER_INSTANT_OUTBOUND: 'CASH',
  INTEREST_PAYMENT: 'CASH',
  DIVIDEND: 'CASH',
  BENEFITS_SAVEBACK: 'CASH',
  TAX_OPTIMIZATION: 'CASH',
  CARD_TRANSACTION: 'CASH',
};

const INVESTMENT_CASH_TYPES = new Set([
  'CUSTOMER_INBOUND',
  'CUSTOMER_OUTBOUND_REQUEST',
  'TRANSFER_INBOUND',
  'TRANSFER_OUTBOUND',
  'TRANSFER_INSTANT_INBOUND',
  'TRANSFER_INSTANT_OUTBOUND',
  'INTEREST_PAYMENT',
  'DIVIDEND',
  'BENEFITS_SAVEBACK',
  'TAX_OPTIMIZATION',
]);

const parseCache = new Map();

export function parseCsv(text) {
  const cached = parseCache.get(text);
  if (cached) return cached;
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      record.push(field);
      field = '';
      if (record.some((value) => value !== '')) records.push(record);
      record = [];
      if (character === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('Il CSV contiene un campo tra virgolette non chiuso.');
  if (field !== '' || record.length > 0) {
    record.push(field);
    if (record.some((value) => value !== '')) records.push(record);
  }
  if (records.length < 2) throw new Error('Il CSV non contiene operazioni.');

  const headers = records[0].map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim(),
  );
  const missing = REQUIRED_COLUMNS.filter((header) => !headers.includes(header));
  if (missing.length) {
    throw new Error(`Intestazioni CSV mancanti: ${missing.join(', ')}.`);
  }

  const errors = [];
  const rows = [];
  const unknownTypesMap = new Map(); // type -> { count, sampleRows: [] }

  records.slice(1).forEach((values, index) => {
    if (values.length !== headers.length) {
      errors.push(`Riga ${index + 2}: numero di colonne non valido.`);
      return;
    }
    const row = Object.fromEntries(headers.map((header, column) => [header, values[column].trim()]));
    const issue = validateRow(row);
    if (issue) {
      errors.push(`Riga ${index + 2}: ${issue}`);
      // Tipi non riconosciuti (anche vuoti): tracciati dal valore della riga, non dal testo dell'errore.
      if (issue === unsupportedTypeIssue(row.type)) {
        const entry = unknownTypesMap.get(row.type) || { count: 0, sampleRows: [] };
        entry.count += 1;
        if (entry.sampleRows.length < 3) {
          entry.sampleRows.push({ rowNumber: index + 2, ...row });
        }
        unknownTypesMap.set(row.type, entry);
      }
    } else {
      rows.push(row);
    }
  });
  if (!rows.length) throw new Error(`Nessuna operazione valida. ${errors.slice(0, 3).join(' ')}`);

  const unknownTypes = Array.from(unknownTypesMap.entries()).map(([type, data]) => ({
    type,
    count: data.count,
    sampleRows: data.sampleRows,
  }));

  const result = { rows, errors, unknownTypes };
  parseCache.set(text, result);
  return result;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function unsupportedTypeIssue(type) {
  return `tipo operazione "${type}" non supportato.`;
}

function validateRow(row) {
  const datetimeMatch = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(row.datetime);
  if (!datetimeMatch || !isValidIsoDate(datetimeMatch[1]) || Number.isNaN(Date.parse(row.datetime))) {
    return 'data/ora non valida.';
  }
  if (!isValidIsoDate(row.date)) return 'data non valida.';
  if (!row.transaction_id) return 'transaction_id mancante.';
  if (!Object.hasOwn(CATEGORIES_BY_TYPE, row.type)) return unsupportedTypeIssue(row.type);
  if (!['CASH', 'TRADING', 'DELIVERY'].includes(row.category)) return `categoria "${row.category}" sconosciuta.`;
  if (CATEGORIES_BY_TYPE[row.type] && CATEGORIES_BY_TYPE[row.type] !== row.category) {
    return `categoria non coerente con ${row.type}.`;
  }
  if (['BUY', 'SELL'].includes(row.type)) {
    const shares = numeric(row.shares);
    const price = numeric(row.price);
    const amount = numeric(row.amount);
    if (!row.symbol || shares === 0 || price <= 0 || amount === 0) return 'operazione BUY/SELL incompleta.';
    if (row.type === 'BUY' && (shares < 0 || amount > 0)) return 'BUY deve avere shares positive e amount negativo.';
    if (row.type === 'SELL' && (shares > 0 || amount < 0)) return 'SELL deve avere shares negative e amount positivo.';
  }
  if (row.type === 'DIVIDEND' && numeric(row.amount) <= 0) return 'DIVIDEND deve avere amount positivo.';
  if (row.type === 'DIVIDEND' && (!row.symbol || !['STOCK', 'FUND'].includes(row.asset_class))) {
    return 'DIVIDEND richiede symbol e asset_class STOCK o FUND.';
  }
  for (const column of ['shares', 'price', 'amount', 'fee', 'tax', 'fx_rate']) {
    if (row[column] !== '' && !Number.isFinite(Number(row[column]))) return `${column} non numerico.`;
  }
  if (row.type === 'CUSTOMER_OUTBOUND_REQUEST' && numeric(row.amount) >= 0) {
    return 'CUSTOMER_OUTBOUND_REQUEST deve avere amount negativo.';
  }
  if (row.currency && row.currency !== 'EUR' && numeric(row.fx_rate) <= 0) return 'tasso FX mancante per importi non EUR.';
  return null;
}

function numeric(value) {
  if (value === '' || value == null) return 0;
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function amountInEur(row, field) {
  const value = numeric(row[field]);
  return row.currency && row.currency !== 'EUR' ? value * numeric(row.fx_rate) : value;
}

export function derivePortfolio(imports, settings) {
  const transactions = [];
  const errors = [];
  const seenIds = new Set();
  const importStats = [];

  imports.forEach((file) => {
    let parsed;
    try {
      parsed = parseCsv(file.content);
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
      importStats.push({ id: file.id, count: 0, invalid: 1, message: error.message, unknownTypes: [] });
      return;
    }
    let duplicates = 0;
    parsed.rows.forEach((row) => {
      if (seenIds.has(row.transaction_id)) {
        duplicates += 1;
        return;
      }
      seenIds.add(row.transaction_id);
      transactions.push({ ...row, importId: file.id });
    });
    importStats.push({
      id: file.id,
      count: parsed.rows.length - duplicates,
      invalid: parsed.errors.length,
      duplicates,
      message: parsed.errors.slice(0, 3).join(' '),
      unknownTypes: parsed.unknownTypes,
    });
  });

  transactions.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  const positions = new Map();
  let investmentCash = 0;
  let risparmiCash = numeric(settings.correntiOpening) + numeric(settings.risparmiOpening);
  if (risparmiCash === 0 && settings.expensesOpening !== undefined) {
    risparmiCash = numeric(settings.expensesOpening);
  }
  const emergencyCash = numeric(settings.emergencyOpening);
  let migrationCount = 0;
  const cashflows = [];

  for (const row of transactions) {
    const amount = amountInEur(row, 'amount');
    const fee = amountInEur(row, 'fee');
    const tax = amountInEur(row, 'tax');
    let cashAccount = null;
    let cashDelta = 0;

    if (row.type === 'BUY' || row.type === 'SELL' || row.type === 'MIGRATION') {
      if (row.type === 'MIGRATION') migrationCount += 1;
      const position = positions.get(row.symbol) ?? {
        id: row.asset_class === 'CRYPTO'
          ? (settings.cryptoMap?.[row.symbol] || `CRYPTO_${row.symbol}`)
          : row.symbol,
        symbol: row.symbol,
        name: row.name || row.symbol,
        assetClass: row.asset_class || 'UNKNOWN',
        shares: 0,
        price: 0,
      };
      position.shares += numeric(row.shares);
      if (numeric(row.price) > 0) {
        position.price = numeric(row.price) * (row.currency && row.currency !== 'EUR' ? numeric(row.fx_rate) : 1);
      }
      position.name = row.name || position.name;
      position.assetClass = row.asset_class || position.assetClass;
      positions.set(row.symbol, position);
      if (row.type !== 'MIGRATION') {
        cashAccount = 'Investimenti';
        cashDelta = amount + fee + tax;
      }
    } else if (row.type === 'CARD_TRANSACTION') {
      const account = (settings.mccRules?.[row.mcc_code] ?? settings.defaultAccount ?? 'Spese').toLowerCase();
      if (account === 'investimenti') {
        cashAccount = 'Investimenti';
        cashDelta = amount;
      } else {
        risparmiCash += amount;
        cashflows.push({ date: row.date, type: row.type, amount, account: 'risparmi' });
      }
    } else if (INVESTMENT_CASH_TYPES.has(row.type)) {
      cashAccount = 'Investimenti';
      cashDelta = row.type === 'TAX_OPTIMIZATION'
        ? tax
        : row.type === 'CUSTOMER_OUTBOUND_REQUEST' ? amount : amount + tax;
    }

    if (cashAccount === 'Investimenti') investmentCash += cashDelta;
    if (cashAccount) {
      cashflows.push({
        date: row.date,
        type: row.type,
        amount: cashDelta,
        account: cashAccount,
      });
    }
  }

  const assets = [...positions.values()].filter((position) => Math.abs(position.shares) > 1e-10);
  assets.forEach((position) => {
    const observed = numeric(settings.priceOverrides?.[position.id]);
    if (observed > 0) position.price = observed;
    position.marketValue = position.shares * position.price;
  });

  const assetsById = new Map(settings.assets.map((asset) => [asset.isin.toUpperCase(), asset]));
  const grouped = assets.map((position) => {
    const asset = assetsById.get(position.id.toUpperCase()) ??
      settings.assets.find((candidate) => candidate.ticker?.toUpperCase() === position.symbol.toUpperCase());
    const excluded = settings.excludedAssets?.includes(position.id);
    return {
      ...position,
      portfolio: excluded ? null : asset?.portfolio ?? 'SATELLITE',
      targetWeight: numeric(asset?.targetWeight),
      displayName: asset?.name || position.name,
      identifier: asset?.isin || position.id,
    };
  });

  const coreValue = grouped.filter((asset) => asset.portfolio === 'CORE')
    .reduce((total, asset) => total + asset.marketValue, 0);
  const satelliteValue = grouped.filter((asset) => asset.portfolio === 'SATELLITE')
    .reduce((total, asset) => total + asset.marketValue, 0);
  const unassignedValue = grouped.filter((asset) => asset.portfolio == null)
    .reduce((total, asset) => total + asset.marketValue, 0);
  const investmentsValue = coreValue + satelliteValue + unassignedValue + investmentCash;
  const expenseCash = risparmiCash; // Alias per compatibilità
  const totalValue = investmentsValue + expenseCash + emergencyCash;

  return {
    transactions,
    groupedAssets: grouped,
    investmentCash,
    risparmiCash,
    expenseCash,
    emergencyCash,
    coreValue,
    satelliteValue,
    unassignedValue,
    investmentsValue,
    totalValue,
    migrationCount,
    cashflows,
    importStats,
    errors,
    lastDate: transactions.at(-1)?.date ?? null,
  };
}

export function reconcileLiquidityBalances(result, {
  risparmiBalance = null,
  emergencyBalance = null,
  // Deprecato: per compatibilità con i saldi Spese precedenti.
  correntiBalance = null,
  expensesBalance = null,
} = {}) {
  const existingRisparmi = Number.isFinite(result.risparmiCash)
    ? result.risparmiCash + (Number.isFinite(result.correntiCash) ? result.correntiCash : 0)
    : result.expenseCash ?? 0;
  const totalLiquidity = result.investmentCash + existingRisparmi + result.emergencyCash;
  const legacyBalances = (Number.isFinite(correntiBalance) ? correntiBalance : 0) +
    (Number.isFinite(expensesBalance) ? expensesBalance : 0);
  const hasManualRisparmi = risparmiBalance !== null || correntiBalance !== null || expensesBalance !== null;
  const risparmi = risparmiBalance === null
    ? (hasManualRisparmi ? legacyBalances : 0)
    : risparmiBalance + (Number.isFinite(correntiBalance) ? correntiBalance : 0);
  const emergency = emergencyBalance ?? result.emergencyCash;
  const investment = totalLiquidity - risparmi - emergency;

  return {
    ...result,
    investmentCash: investment,
    risparmiCash: risparmi,
    expenseCash: risparmi,
    emergencyCash: emergency,
    investmentsValue: result.coreValue + result.satelliteValue + result.unassignedValue + investment,
    totalValue: result.coreValue + result.satelliteValue + result.unassignedValue + investment + risparmi + emergency,
  };
}

export function buildAnnualBalanceReport(result, year) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  if (year >= new Date().getFullYear()) {
    return { valid: false, reason: `L'anno ${year} non è ancora concluso: il saldo al 31/12 non è disponibile.` };
  }
  const transactions = result.transactions.filter((row) => row.date <= yearEnd);
  if (!transactions.some((row) => row.date.slice(0, 4) === String(year))) {
    return { valid: false, reason: `Non ci sono operazioni CSV per il ${year}.` };
  }

  const dailyCashflows = new Map();
  // Usa TUTTI i flussi di cassa per calcolare la liquidità complessiva (Giacenza Media)
  result.cashflows
    .filter((flow) => flow.date <= yearEnd)
    .forEach((flow) => {
      dailyCashflows.set(flow.date, (dailyCashflows.get(flow.date) ?? 0) + flow.amount);
    });
  let liquidity = 0;
  let openingLiquidity = 0;
  for (const [date, amount] of [...dailyCashflows].sort(([a], [b]) => a.localeCompare(b))) {
    liquidity += amount;
    if (liquidity < -0.005) {
      return {
        valid: false,
        reason: `Il saldo liquido ricostruito diventa negativo il ${date}. I CSV non contengono tutti i movimenti dall'apertura del conto; importa lo storico completo prima di generare il PDF.`,
      };
    }
    if (Math.abs(liquidity) < 0.005) liquidity = 0;
    if (date < yearStart) openingLiquidity = liquidity;
  }
  const closingLiquidity = liquidity;

  let liquidityTotal = 0;
  let days = 0;
  liquidity = openingLiquidity;
  const cursor = new Date(`${yearStart}T12:00:00Z`);
  const final = new Date(`${yearEnd}T12:00:00Z`);
  while (cursor <= final) {
    const date = cursor.toISOString().slice(0, 10);
    liquidity += dailyCashflows.get(date) ?? 0;
    if (liquidity < -0.005) {
      return {
        valid: false,
        reason: `Il saldo liquido ricostruito diventa negativo il ${date}. I CSV non contengono tutti i movimenti dall'apertura del conto; importa lo storico completo prima di generare il PDF.`,
      };
    }
    if (Math.abs(liquidity) < 0.005) liquidity = 0;
    liquidityTotal += liquidity;
    days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const positions = new Map();
  for (const row of transactions) {
    if (!['BUY', 'SELL', 'MIGRATION'].includes(row.type)) continue;
    const entry = positions.get(row.symbol) ?? {
      name: row.name || row.symbol,
      shares: 0,
      price: 0,
    };
    entry.shares += numeric(row.shares);
    const fxRate = row.currency && row.currency !== 'EUR' ? numeric(row.fx_rate) : 1;
    if (numeric(row.price) > 0) entry.price = numeric(row.price) * fxRate;
    entry.name = row.name || entry.name;
    positions.set(row.symbol, entry);
  }
  const unpricedPosition = [...positions.values()].find((position) =>
    Math.abs(position.shares) > 1e-10 && position.price <= 0,
  );
  if (unpricedPosition) {
    return {
      valid: false,
      reason: `Prezzo CSV mancante per ${unpricedPosition.name}; il conto titoli al 31/12 non è calcolabile.`,
    };
  }
  const securitiesClosing = [...positions.values()].reduce(
    (total, position) => total + position.shares * position.price,
    0,
  );
  if (securitiesClosing < -0.005) {
    return {
      valid: false,
      reason: 'Il valore netto del conto titoli al 31/12 risulta negativo; verifica che lo storico CSV sia completo.',
    };
  }
  return {
    valid: true,
    year,
    days,
    averageLiquidity: liquidityTotal / days,
    securitiesClosing,
    liquidityClosing: closingLiquidity,
  };
}

export function validateAllocations(assets, sectionTargets = { CORE: 100, SATELLITE: 100 }) {
  return ['CORE', 'SATELLITE'].map((portfolio) => {
    const members = assets.filter((asset) => asset.portfolio === portfolio);
    const sum = members.reduce((total, asset) => total + numeric(asset.targetWeight), 0);
    const target = numeric(sectionTargets[portfolio]);
    const weightsInRange = target >= 0 && target <= 100 &&
      members.every((asset) => numeric(asset.targetWeight) >= 0 && numeric(asset.targetWeight) <= target);
    const sumDoesNotExceedTarget = sum <= target + Number.EPSILON * Math.max(1, Math.abs(target));
    const valid = weightsInRange && sumDoesNotExceedTarget && (members.length === 0
      ? Math.abs(target) <= 0.1
      : Math.abs(sum - target) <= 0.1);
    return { portfolio, sum, target, valid };
  });
}

export function validateAllocationConfiguration(sections) {
  const entries = Object.entries(sections);
  const sectionWeightSum = entries.reduce((sum, [, section]) => sum + numeric(section.targetWeight), 0);
  const sectionWeightsValid = sectionWeightSum <= 100 + Number.EPSILON * 100 &&
    Math.abs(sectionWeightSum - 100) <= 0.1;
  const sectionWeightsInRange = entries.every(([, section]) => {
    const targetWeight = numeric(section.targetWeight);
    return targetWeight >= 0 && targetWeight <= 100;
  });
  const results = entries.map(([portfolio, section]) => {
    const assetWeightSum = section.assetWeights.reduce((sum, weight) => sum + numeric(weight), 0);
    const targetWeight = numeric(section.targetWeight);
    const weightsInRange = targetWeight >= 0 && targetWeight <= 100 &&
      section.assetWeights.every((weight) => numeric(weight) >= 0 && numeric(weight) <= targetWeight);
    const assetSumDoesNotExceedTarget = assetWeightSum <= targetWeight +
      Number.EPSILON * Math.max(1, Math.abs(targetWeight));
    const distributionValid = weightsInRange && assetSumDoesNotExceedTarget && (section.assetWeights.length === 0
      ? Math.abs(numeric(section.targetWeight)) <= 0.1
      : Math.abs(assetWeightSum - targetWeight) <= 0.1);
    return {
      portfolio,
      targetWeight,
      assetWeightSum,
      hasAssets: section.assetWeights.length > 0,
      weightsInRange,
      distributionValid,
    };
  });

  return {
    sectionWeightSum,
    sectionWeightsValid,
    sectionWeightsInRange,
    sections: results,
    valid: sectionWeightsValid && sectionWeightsInRange && results.every((section) => section.distributionValid),
  };
}

export function normalizeSectionWeights(values) {
  const weights = {
    CORE: Math.max(0, numeric(values.CORE)),
    SATELLITE: Math.max(0, numeric(values.SATELLITE)),
    CASH: Math.max(0, numeric(values.CASH)),
  };
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { CORE: 0, SATELLITE: 0, CASH: 100 };

  for (const section of Object.keys(weights)) {
    weights[section] = Math.round(weights[section] / total * 1000) / 10;
  }
  const largestSection = Object.keys(weights).reduce((largest, section) =>
    weights[section] > weights[largest] ? section : largest,
  );
  const roundedTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
  weights[largestSection] += 100 - roundedTotal;
  return weights;
}

export function calculateRebalancingMetrics({
  assetValue,
  portfolioValue,
  investmentValue,
  sectionTarget,
  targetWeight,
  thresholdAP,
  thresholdA,
  thresholdRelative = 0,
  minAmount = 0,
}) {
  const deltaAP = portfolioValue
    ? assetValue / portfolioValue * 100 - targetWeight
    : -targetWeight;
  const targetA = sectionTarget * targetWeight / 100;
  const actualA = investmentValue ? assetValue / investmentValue * 100 : 0;
  const deltaA = actualA - targetA;
  const targetEuro = investmentValue * targetA / 100;
  const deltaEuro = targetEuro - assetValue;
  // Banda = max(soglia assoluta, % del target): evita ordini inutili sugli asset piccoli.
  const bandAP = Math.max(thresholdAP, targetWeight * thresholdRelative / 100);
  const bandA = Math.max(thresholdA, targetA * thresholdRelative / 100);
  // Senza importo da movimentare (meno di un centesimo o dell'importo minimo) non c'è operazione da proporre.
  const status = (Math.abs(deltaAP) <= bandAP && Math.abs(deltaA) <= bandA)
    || Math.abs(deltaEuro) < Math.max(0.005, minAmount)
    ? 'HOLD'
    : deltaEuro > 0 ? 'BUY' : 'SELL';

  return { deltaAP, deltaA, targetEuro, deltaEuro, status };
}

export function formatCurrency(value) {
  const amount = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount) < 0.005 ? 0 : amount);
}

export function formatNumber(value, digits = 4) {
  return new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
}

export function parseLocaleNumber(value) {
  if (typeof value === 'number') return value;
  const input = String(value ?? '').trim();
  // "1.500" e "1.234.567" sono migliaia in formato it-IT (come li mostra formatNumber);
  // "12.5" e "0.125" restano decimali con il punto.
  const italianThousands = /^-?[1-9]\d{0,2}(\.\d{3})+$/.test(input);
  const normalized = input.includes(',') || italianThousands
    ? input.replace(/\./g, '').replace(',', '.')
    : input;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
