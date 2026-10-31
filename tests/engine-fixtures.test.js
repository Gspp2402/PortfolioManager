// Collaudo del motore con i CSV sintetici in tests/fixtures.
// I risultati attesi sono calcolati a mano (vedi tests/fixtures/README.md) e
// NON derivano dall'engine: in caso di divergenza è l'engine a essere sospetto.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import mccConfig from '../src/data/mcc_mapping.json' with { type: 'json' };
import {
  buildAnnualBalanceReport,
  calculateRebalancingMetrics,
  derivePortfolio,
  normalizeSectionWeights,
  parseCsv,
  parseLocaleNumber,
  reconcileLiquidityBalances,
  validateAllocationConfiguration,
} from '../src/js/portfolio-engine.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (folder, name) => readFileSync(join(fixtures, folder, name), 'utf-8');
const file = (name, folder = 'valid') => ({ id: name, name, content: read(folder, name) });
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: atteso ${expected}, ottenuto ${actual}`);

const settings = (extra = {}) => ({
  assets: [],
  cryptoMap: {},
  mccRules: { ...mccConfig.mcc_rules },
  defaultAccount: mccConfig.default_conto,
  ...extra,
});

const ORDER_ABC = ['SYN_GEN_25.csv', 'SYN_FEB_25.csv', 'SYN_DIC_25.csv'];

test('fixture validi: posizioni, prezzi, FX, crypto, MCC e liquidità attesi', () => {
  const result = derivePortfolio(ORDER_ABC.map((name) => file(name)), settings());
  assert.equal(result.errors.length, 0);
  assert.equal(result.transactions.length, 19, '20 righe valide nei tre file, 1 duplicato tra file');
  assert.deepEqual(result.importStats.map((item) => item.duplicates), [0, 1, 0]);

  const byId = Object.fromEntries(result.groupedAssets.map((asset) => [asset.id, asset]));
  near(byId.SYN0FUND0001.shares, 40, 'quote fondo dopo SELL');
  near(byId.SYN0FUND0001.price, 110, 'ultimo prezzo fondo');
  near(byId.SYN0STCK0001.price, 45, 'prezzo USD convertito con fx_rate');
  near(byId.SYN0FUND0002.shares, 6, 'MIGRATION + BUY');
  near(byId.SYN0FUND0002.price, 20, 'prezzo dopo MIGRATION senza prezzo');
  assert.ok(byId.CRYPTO_SYNC, 'crypto senza mapping usa CRYPTO_<ticker>');
  assert.equal(byId.SYN0FUND0001.name, 'Fondo Sintetico "Globale", Acc', 'quoting RFC 4180');

  near(result.investmentCash, 4764.1, 'cassa investimenti');
  near(result.risparmiCash, -90, 'spese carta MCC 5812 + MCC non mappato');
  near(result.coreValue + result.satelliteValue, 6200, 'valore titoli');
  near(result.totalValue, 10874.1, 'totale conto');
  assert.equal(result.migrationCount, 1);
  assert.equal(result.lastDate, '2026-01-05');
});

test('precedenza duplicati: vince il primo file nell’ordine corrente', () => {
  const abc = derivePortfolio(ORDER_ABC.map((name) => file(name)), settings());
  const bac = derivePortfolio(['SYN_FEB_25.csv', 'SYN_GEN_25.csv', 'SYN_DIC_25.csv'].map((name) => file(name)), settings());
  near(bac.totalValue - abc.totalValue, 999 - 5.5, 'il duplicato syn-a10 del secondo file prevale solo se viene prima');
  assert.deepEqual(bac.importStats.map((item) => item.duplicates), [0, 1, 0]);
});

test('i calcoli non dipendono dall’ordine cronologico delle righe né dei file senza duplicati', () => {
  const ac = derivePortfolio([file('SYN_GEN_25.csv'), file('SYN_DIC_25.csv')], settings());
  const ca = derivePortfolio([file('SYN_DIC_25.csv'), file('SYN_GEN_25.csv')], settings());
  near(ac.totalValue, ca.totalValue, 'totale indipendente dall’ordine');
  assert.deepEqual(ac.transactions.map((row) => row.transaction_id), ca.transactions.map((row) => row.transaction_id));
});

test('il conto di default per le CARD_TRANSACTION viene da mcc_mapping.json', () => {
  const content = read('valid', 'SYN_GEN_25.csv');
  const toInvest = derivePortfolio([{ id: 'a', name: 'a', content }], settings({ mccRules: {}, defaultAccount: 'Investimenti' }));
  near(toInvest.risparmiCash, 0, 'nessuna spesa su Risparmi se il default è Investimenti');
  const toSpese = derivePortfolio([{ id: 'a', name: 'a', content }], settings({ mccRules: {}, defaultAccount: 'Spese' }));
  near(toSpese.risparmiCash, -140, 'tutte le carte su Spese');
});

test('saldo unico Risparmi ed Emergenze: nessun doppio conteggio della liquidità', () => {
  const base = derivePortfolio(ORDER_ABC.map((name) => file(name)), settings());
  const liquidity = base.investmentCash + base.risparmiCash + base.emergencyCash;
  const split = reconcileLiquidityBalances(base, { risparmiBalance: 1000, emergencyBalance: 1000 });
  near(split.risparmiCash + split.emergencyCash + split.investmentCash, liquidity, 'liquidità invariata');
  near(split.investmentCash, liquidity - 2000, 'cash investimenti ridotta degli importi assegnati');
  near(split.totalValue, base.totalValue, 'totale conto invariato');
  const legacy = reconcileLiquidityBalances(base, {
    correntiBalance: 300,
    risparmiBalance: 700,
    emergencyBalance: 1000,
  });
  near(legacy.risparmiCash, 1000, 'gli override legacy Corrente e Risparmi confluiscono in Risparmi');
  near(legacy.totalValue, base.totalValue, 'la migrazione legacy non cambia il totale');
  const untouched = reconcileLiquidityBalances(base, {});
  near(untouched.risparmiCash, 0, 'senza override la liquidità resta non assegnata');
  near(untouched.investmentCash, liquidity, 'la liquidità non assegnata resta in Cash Investimenti');
  near(untouched.totalValue, base.totalValue, 'il totale resta invariato senza override');
});

test('Giacenza Media 2025 sui fixture: media giornaliera e saldi al 31/12 attesi', () => {
  // Oracolo indipendente: flussi giornalieri aggregati scritti a mano dai fixture.
  const flows = {
    '2025-01-02': 10000, '2025-01-03': -6002, '2025-01-04': -450, '2025-01-05': -201,
    '2025-01-10': -50, '2025-01-11': -30, '2025-01-12': -20, '2025-01-13': -40,
    '2025-01-31': 5.5, '2025-02-03': 7.4, '2025-02-04': 1099, '2025-02-06': -20,
    '2025-02-07': 3.2, '2025-02-08': -100, '2025-02-09': 2, '2025-12-15': 500,
  };
  let balance = 0;
  let sum = 0;
  for (let day = new Date('2025-01-01T12:00:00Z'); day.getUTCFullYear() === 2025; day.setUTCDate(day.getUTCDate() + 1)) {
    balance += flows[day.toISOString().slice(0, 10)] ?? 0;
    sum += balance;
  }
  const result = derivePortfolio(ORDER_ABC.map((name) => file(name)), settings());
  const report = buildAnnualBalanceReport(result, 2025);
  assert.equal(report.valid, true, report.reason);
  assert.equal(report.days, 365);
  near(report.averageLiquidity, sum / 365, 'media giornaliera');
  near(report.liquidityClosing, 4704.1, 'liquidità al 31/12');
  near(report.securitiesClosing, 6170, 'titoli al 31/12 (escluso l’acquisto 2026)');
  assert.equal(buildAnnualBalanceReport(result, 2024).valid, false, 'anno senza operazioni');
  assert.equal(buildAnnualBalanceReport(result, new Date().getFullYear()).valid, false, 'anno non concluso');
});

test('CSV non validi: ogni file produce l’errore atteso senza contaminare i validi', () => {
  const expectations = {
    'INV_missing_header.csv': { throws: /Intestazioni CSV mancanti: mcc_code/ },
    'INV_unclosed_quote.csv': { throws: /virgolette non chiuso/ },
    'INV_no_valid_rows.csv': { throws: /Nessuna operazione valida/ },
    'INV_wrong_columns.csv': { error: /numero di colonne non valido/ },
    'INV_impossible_date.csv': { error: /data\/ora non valida/ },
    'INV_bad_timestamp.csv': { error: /data\/ora non valida/ },
    'INV_non_numeric.csv': { error: /amount non numerico/ },
    'INV_currency_no_fx.csv': { error: /tasso FX mancante/ },
    'INV_sign_mismatch.csv': { error: /BUY deve avere shares positive e amount negativo/ },
    'INV_bad_category.csv': { error: /categoria non coerente con BUY/ },
    'INV_missing_txid.csv': { error: /transaction_id mancante/ },
    'INV_unknown_type.csv': { error: /non supportato/, errors: 3 },
  };
  const names = readdirSync(join(fixtures, 'invalid')).filter((name) => name.endsWith('.csv'));
  assert.deepEqual(names.sort(), Object.keys(expectations).sort(), 'ogni fixture negativo ha un’aspettativa');
  for (const [name, expected] of Object.entries(expectations)) {
    const content = read('invalid', name);
    if (expected.throws) {
      assert.throws(() => parseCsv(content), expected.throws, name);
      continue;
    }
    const parsed = parseCsv(content);
    assert.equal(parsed.rows.length, 1, `${name}: resta solo la riga valida`);
    assert.equal(parsed.errors.length, expected.errors ?? 1, name);
    assert.match(parsed.errors[0], expected.error, name);
  }
  const mixed = derivePortfolio([file('SYN_GEN_25.csv'), file('INV_missing_header.csv', 'invalid')], settings());
  assert.equal(mixed.transactions.length, 10, 'il file non valido non altera i dati validi');
  assert.equal(mixed.importStats[1].invalid, 1);
});

test('tipi sconosciuti: statistiche per tipo, inclusi i tipi vuoti', () => {
  const parsed = parseCsv(read('invalid', 'INV_unknown_type.csv'));
  const byType = Object.fromEntries(parsed.unknownTypes.map((item) => [item.type, item.count]));
  assert.equal(byType.SYNTHETIC_UNKNOWN, 2);
  assert.equal(byType[''], 1, 'un tipo vuoto va segnalato, non perso');
  assert.ok(parsed.unknownTypes.every((item) => item.sampleRows.length <= 3));
});

// --- Ribilanciamento ---------------------------------------------------------
// Replica fedele della composizione usata da renderPortfolio() in portfolio-app.js:
// (A|P) = (A) / peso sezione × 100; portfolioValue = valore della sezione.
function rebalance(result, config, { thresholdA = 5, thresholdAP = 3 } = {}) {
  const sectionValue = { CORE: result.coreValue, SATELLITE: result.satelliteValue, CASH: result.investmentCash };
  const rows = config.assets.map((asset) => {
    const held = result.groupedAssets.find((item) => item.identifier === asset.isin);
    const sectionWeight = config.sections[asset.portfolio];
    const ap = sectionWeight > 0 ? asset.targetWeight / sectionWeight * 100 : 0;
    return {
      isin: asset.isin,
      ...calculateRebalancingMetrics({
        assetValue: held?.marketValue ?? 0,
        portfolioValue: sectionValue[asset.portfolio],
        investmentValue: result.investmentsValue,
        sectionTarget: sectionWeight,
        targetWeight: ap,
        thresholdA,
        thresholdAP,
      }),
    };
  });
  rows.push({
    isin: 'CASH',
    ...calculateRebalancingMetrics({
      assetValue: result.investmentCash,
      portfolioValue: result.investmentCash,
      investmentValue: result.investmentsValue,
      sectionTarget: config.sections.CASH,
      targetWeight: 100,
      thresholdA,
      thresholdAP,
    }),
  });
  return rows;
}

const REBAL_ASSETS = (x, y, z) => [
  { isin: 'SYN0REBX0001', portfolio: 'CORE', targetWeight: x },
  { isin: 'SYN0REBY0001', portfolio: 'CORE', targetWeight: y },
  { isin: 'SYN0REBZ0001', portfolio: 'SATELLITE', targetWeight: z },
];

function rebalResult(config) {
  return derivePortfolio([file('SYN_REBAL.csv', 'rebalancing')], settings({ assets: config.assets }));
}

test('ribilanciamento: target esatti → solo HOLD e ΔEUR nullo', () => {
  const config = { sections: { CORE: 80, SATELLITE: 10, CASH: 10 }, assets: REBAL_ASSETS(60, 20, 10) };
  const rows = rebalance(rebalResult(config), config);
  assert.deepEqual(rows.map((row) => row.status), ['HOLD', 'HOLD', 'HOLD', 'HOLD']);
  rows.forEach((row) => near(row.deltaEuro, 0, row.isin));
});

test('ribilanciamento: sopra/sotto soglia, solo BUY, solo SELL e somma ΔEUR nulla', () => {
  const mixed = { sections: { CORE: 80, SATELLITE: 10, CASH: 10 }, assets: REBAL_ASSETS(40, 40, 10) };
  const mixedRows = rebalance(rebalResult(mixed), mixed);
  assert.deepEqual(mixedRows.map((row) => row.status), ['SELL', 'BUY', 'HOLD', 'HOLD']);
  near(mixedRows[0].deltaEuro, -2000, 'X sovrappesato di 2000 EUR');
  near(mixedRows[1].deltaEuro, 2000, 'Y sottopesato di 2000 EUR');
  near(mixedRows.reduce((sum, row) => sum + row.deltaEuro, 0), 0, 'gli scambi si compensano');

  const onlyBuy = { sections: { CORE: 90, SATELLITE: 10, CASH: 0 }, assets: REBAL_ASSETS(67.5, 22.5, 10) };
  const buyRows = rebalance(rebalResult(onlyBuy), onlyBuy, { thresholdA: 1, thresholdAP: 3 }).slice(0, 3);
  assert.deepEqual(buyRows.map((row) => row.status), ['BUY', 'BUY', 'HOLD']);

  const onlySell = { sections: { CORE: 40, SATELLITE: 4, CASH: 56 }, assets: REBAL_ASSETS(30, 10, 4) };
  const sellRows = rebalance(rebalResult(onlySell), onlySell);
  assert.deepEqual(sellRows.map((row) => row.status), ['SELL', 'SELL', 'SELL', 'BUY']);
  near(sellRows.reduce((sum, row) => sum + row.deltaEuro, 0), 0, 'gli scambi si compensano');
});

test('ribilanciamento: asset a peso zero, soglie personalizzate, cassa a zero senza azioni', () => {
  const zero = { sections: { CORE: 80, SATELLITE: 10, CASH: 10 }, assets: [...REBAL_ASSETS(60, 20, 10).slice(0, 2), { isin: 'SYN0REBZ0001', portfolio: 'SATELLITE', targetWeight: 0 }, { isin: 'SYN0NOTHELD1', portfolio: 'SATELLITE', targetWeight: 10 }] };
  const rows = rebalance(rebalResult(zero), zero);
  assert.equal(rows[2].status, 'SELL', 'asset detenuto con target 0');
  near(rows[2].deltaEuro, -1000, 'vendere tutto');
  assert.equal(rows[3].status, 'BUY', 'asset non detenuto con target > 0');

  const loose = { sections: { CORE: 80, SATELLITE: 10, CASH: 10 }, assets: REBAL_ASSETS(55, 25, 10) };
  assert.deepEqual(rebalance(rebalResult(loose), loose, { thresholdA: 5, thresholdAP: 3 }).map((r) => r.status).slice(0, 2), ['SELL', 'BUY']);
  assert.deepEqual(rebalance(rebalResult(loose), loose, { thresholdA: 5, thresholdAP: 7 }).map((r) => r.status).slice(0, 2), ['HOLD', 'HOLD']);

  const noCash = calculateRebalancingMetrics({ assetValue: 0, portfolioValue: 0, investmentValue: 10000, sectionTarget: 0, targetWeight: 100, thresholdA: 5, thresholdAP: 3 });
  assert.equal(noCash.status, 'HOLD', 'cassa 0 con target 0: nessuna operazione da proporre');
});

test('normalizzazione pesi e coerenza sezione/asset', () => {
  const third = normalizeSectionWeights({ CORE: 1, SATELLITE: 1, CASH: 1 });
  near(third.CORE, 33.4, 'arrotondamento assegnato alla sezione maggiore');
  near(third.CORE + third.SATELLITE + third.CASH, 100, 'somma 100');
  assert.deepEqual(normalizeSectionWeights({ CORE: 0, SATELLITE: 0, CASH: 0 }), { CORE: 0, SATELLITE: 0, CASH: 100 });
  assert.deepEqual(normalizeSectionWeights({ CORE: -5, SATELLITE: 10, CASH: 10 }), { CORE: 0, SATELLITE: 50, CASH: 50 });
  const valid = validateAllocationConfiguration({
    CORE: { targetWeight: 80, assetWeights: [60, 20] },
    SATELLITE: { targetWeight: 10, assetWeights: [10] },
    CASH: { targetWeight: 10, assetWeights: [10] },
  });
  assert.equal(valid.valid, true);
  const mismatch = validateAllocationConfiguration({
    CORE: { targetWeight: 80, assetWeights: [60, 10] },
    SATELLITE: { targetWeight: 10, assetWeights: [10] },
    CASH: { targetWeight: 10, assetWeights: [10] },
  });
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.sections[0].distributionValid, false);
});

test('input numerici italiani: separatori migliaia e decimali', () => {
  assert.equal(parseLocaleNumber('1.234,56'), 1234.56);
  assert.equal(parseLocaleNumber('1.500'), 1500, 'formato prodotto dall’app per 1500 (formatNumber it-IT)');
  assert.equal(parseLocaleNumber('1.234.567'), 1234567);
  assert.equal(parseLocaleNumber('12.5'), 12.5, 'punto decimale ancora accettato');
  assert.equal(parseLocaleNumber('0.125'), 0.125, 'zero iniziale: non sono migliaia');
  assert.equal(parseLocaleNumber('-1.500,5'), -1500.5);
  assert.equal(parseLocaleNumber('35,2'), 35.2);
});
