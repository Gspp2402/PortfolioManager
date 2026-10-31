import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  validateAllocations,
} from '../src/js/portfolio-engine.js';

const headers = [
  'datetime', 'date', 'category', 'type', 'asset_class', 'name', 'symbol',
  'shares', 'price', 'amount', 'fee', 'tax', 'currency', 'fx_rate',
  'transaction_id', 'mcc_code',
];

function row(type, overrides = {}) {
  const defaults = {
    datetime: '2024-01-01T12:00:00Z',
    date: '2024-01-01',
    category: 'CASH',
    type,
    asset_class: '',
    name: '',
    symbol: '',
    shares: '',
    price: '',
    amount: '',
    fee: '',
    tax: '',
    currency: 'EUR',
    fx_rate: '',
    transaction_id: type,
    mcc_code: '',
  };
  return { ...defaults, ...overrides };
}

function csv(rows) {
  return [
    headers.join(','),
    ...rows.map((item) => headers.map((header) => `"${String(item[header] ?? '').replaceAll('"', '""')}"`).join(',')),
  ].join('\n');
}

test('parses quoted CSV fields and rejects malformed headers', () => {
  const parsed = parseCsv(csv([row('CUSTOMER_INBOUND', { name: 'Sample, "Asset"' })]));
  assert.equal(parsed.rows[0].name, 'Sample, "Asset"');
  assert.throws(() => parseCsv('date,type\n2024-01-01,BUY'), /Intestazioni CSV mancanti/);
});

test('rejects unsupported transaction types instead of silently ignoring cashflows', () => {
  const parsed = parseCsv(csv([
    row('CUSTOMER_INBOUND', { amount: '100', transaction_id: 'supported' }),
    row('CUSTOMER_OUTBOUND_REQUEST', { amount: '-25', transaction_id: 'withdrawal' }),
    row('TRANSFER_UNKNOWN', { amount: '500', transaction_id: 'unsupported' }),
  ]));
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].type, 'CUSTOMER_OUTBOUND_REQUEST');
  assert.match(parsed.errors[0], /tipo operazione "TRANSFER_UNKNOWN" non supportato/);
});

test('applies CUSTOMER_OUTBOUND_REQUEST as an amount-only investment cash withdrawal', () => {
  const result = derivePortfolio([{
    id: 'withdrawal',
    name: 'withdrawal.csv',
    content: csv([
      row('CUSTOMER_INBOUND', {
        date: '2025-01-01', datetime: '2025-01-01T12:00:00Z',
        amount: '100', transaction_id: 'opening',
      }),
      row('CUSTOMER_OUTBOUND_REQUEST', {
        date: '2025-01-02', datetime: '2025-01-02T12:00:00Z',
        amount: '-25', fee: '-3', tax: '-2', transaction_id: 'withdrawal',
      }),
    ]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });

  assert.equal(result.investmentCash, 75);
  assert.equal(result.groupedAssets.length, 0);
  assert.deepEqual(result.cashflows.map(({ type, amount }) => ({ type, amount })), [
    { type: 'CUSTOMER_INBOUND', amount: 100 },
    { type: 'CUSTOMER_OUTBOUND_REQUEST', amount: -25 },
  ]);

  const report = buildAnnualBalanceReport(result, 2025);
  assert.equal(report.valid, true, report.reason);
  assert.equal(report.liquidityClosing, 75);
  assert.equal(report.averageLiquidity, (100 + 75 * 364) / 365);
});

test('rejects CUSTOMER_OUTBOUND_REQUEST rows without a negative amount', () => {
  const parsed = parseCsv(csv([
    row('CUSTOMER_INBOUND', { amount: '100', transaction_id: 'valid' }),
    row('CUSTOMER_OUTBOUND_REQUEST', { amount: '0', transaction_id: 'zero' }),
    row('CUSTOMER_OUTBOUND_REQUEST', { amount: '25', transaction_id: 'positive' }),
  ]));

  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.errors, [
    'Riga 3: CUSTOMER_OUTBOUND_REQUEST deve avere amount negativo.',
    'Riga 4: CUSTOMER_OUTBOUND_REQUEST deve avere amount negativo.',
  ]);
});

test('rejects impossible calendar dates and malformed timestamps', () => {
  const parsed = parseCsv(csv([
    row('CUSTOMER_INBOUND', { amount: '100', transaction_id: 'valid' }),
    row('CUSTOMER_INBOUND', {
      date: '2026-02-30', datetime: '2026-02-28T12:00:00Z',
      amount: '100', transaction_id: 'impossible-date',
    }),
    row('CUSTOMER_INBOUND', {
      date: '2026-02-28', datetime: '2026-02-28 12:00:00',
      amount: '100', transaction_id: 'malformed-timestamp',
    }),
  ]));
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.errors, [
    'Riga 3: data non valida.',
    'Riga 4: data/ora non valida.',
  ]);
});

test('reports malformed CSV rows, categories, numeric values, and dividend requirements', () => {
  const valid = row('CUSTOMER_INBOUND', { amount: '10', transaction_id: 'valid' });
  const malformedRows = [
    row('CUSTOMER_INBOUND', { transaction_id: '', amount: '1' }),
    row('CUSTOMER_INBOUND', { category: 'OTHER', transaction_id: 'unknown-category', amount: '1' }),
    row('BUY', {
      category: 'CASH', symbol: 'IE000TEST0001', shares: '1', price: '1', amount: '-1',
      transaction_id: 'wrong-category',
    }),
    row('CUSTOMER_INBOUND', { amount: 'not-a-number', transaction_id: 'not-numeric' }),
    row('CUSTOMER_INBOUND', {
      amount: '1', currency: 'USD', fx_rate: '', transaction_id: 'missing-fx',
    }),
    row('DIVIDEND', { amount: '0', transaction_id: 'zero-dividend' }),
    row('DIVIDEND', { amount: '1', transaction_id: 'missing-dividend-details' }),
  ];
  const parsed = parseCsv(csv([valid, ...malformedRows]));
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.errors, [
    'Riga 3: transaction_id mancante.',
    'Riga 4: categoria "OTHER" sconosciuta.',
    'Riga 5: categoria non coerente con BUY.',
    'Riga 6: amount non numerico.',
    'Riga 7: tasso FX mancante per importi non EUR.',
    'Riga 8: DIVIDEND deve avere amount positivo.',
    'Riga 9: DIVIDEND richiede symbol e asset_class STOCK o FUND.',
  ]);
  assert.throws(() => parseCsv(''), /Il CSV non contiene operazioni/);
  assert.throws(() => parseCsv(`${headers.join(',')}\n"${headers.join(',')}`), /campo tra virgolette non chiuso/);
  const withMalformedWidth = parseCsv([
    headers.join(','),
    ...[valid].map((item) => headers.map((header) => item[header] ?? '').join(',')),
    'too,few,columns',
  ].join('\n'));
  assert.equal(withMalformedWidth.rows.length, 1);
  assert.deepEqual(withMalformedWidth.errors, ['Riga 3: numero di colonne non valido.']);
});

test('counts invalid imports and rows while deriving valid files', () => {
  const parsedValid = csv([
    row('CUSTOMER_INBOUND', { amount: '100', transaction_id: 'inbound' }),
    row('CUSTOMER_INBOUND', { amount: '1', transaction_id: '' }),
  ]);
  const result = derivePortfolio([
    { id: 'invalid-file', name: 'invalid.csv', content: 'not,a,portfolio,export\nvalue,more,values,here' },
    { id: 'partially-valid', name: 'partial.csv', content: parsedValid },
  ], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  assert.equal(result.investmentCash, 100);
  assert.equal(result.importStats[0].invalid, 1);
  assert.match(result.importStats[0].message, /Intestazioni CSV mancanti/);
  assert.equal(result.importStats[1].count, 1);
  assert.equal(result.importStats[1].invalid, 1);
  assert.match(result.importStats[1].message, /transaction_id mancante/);
  assert.equal(result.errors.length, 1);
});

test('rejects BUY and SELL rows whose amount or share signs contradict the operation', () => {
  const parsed = parseCsv(csv([
    row('CUSTOMER_INBOUND', { amount: '100', transaction_id: 'valid' }),
    row('BUY', {
      category: 'TRADING', asset_class: 'FUND', symbol: 'IE000TEST0001',
      shares: '-1', price: '10', amount: '10', transaction_id: 'invalid-buy',
    }),
    row('SELL', {
      category: 'TRADING', asset_class: 'FUND', symbol: 'IE000TEST0002',
      shares: '1', price: '10', amount: '-10', transaction_id: 'invalid-sell',
    }),
  ]));
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.errors, [
    'Riga 3: BUY deve avere shares positive e amount negativo.',
    'Riga 4: SELL deve avere shares negative e amount positivo.',
  ]);
  assert.throws(() => parseCsv(csv([
    row('BUY', {
      category: 'TRADING', asset_class: 'FUND', symbol: 'IE000TEST0001',
      shares: '-1', price: '10', amount: '10', transaction_id: 'invalid-buy',
    }),
  ])), /Nessuna operazione valida/);
});

test('converts foreign-currency position values and resolves unmapped crypto IDs', () => {
  const result = derivePortfolio([{
    id: 'foreign',
    name: 'foreign.csv',
    content: csv([
      row('BUY', {
        category: 'TRADING', asset_class: 'CRYPTO', name: 'Example Coin', symbol: 'XYZ',
        shares: '2', price: '10', amount: '-20', currency: 'USD', fx_rate: '0.9',
        transaction_id: 'crypto-buy',
      }),
    ]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  assert.equal(result.groupedAssets[0].id, 'CRYPTO_XYZ');
  assert.equal(result.groupedAssets[0].marketValue, 18);
  assert.equal(result.investmentCash, -18);
  assert.equal(result.lastDate, '2024-01-01');
});

test('derives share positions and account cash deterministically', () => {
  const operations = [
    row('CUSTOMER_INBOUND', { amount: '1000' }),
    row('BUY', {
      datetime: '2024-01-02T12:00:00Z', date: '2024-01-02',
      category: 'TRADING', asset_class: 'FUND', name: 'Example Fund', symbol: 'IE000TEST0001',
      shares: '2', price: '100', amount: '-200', fee: '-1', transaction_id: 'buy',
    }),
    row('SELL', {
      datetime: '2024-02-02T12:00:00Z', date: '2024-02-02',
      category: 'TRADING', asset_class: 'FUND', name: 'Example Fund', symbol: 'IE000TEST0001',
      shares: '-0.5', price: '120', amount: '60', fee: '-1', transaction_id: 'sell',
    }),
    row('DIVIDEND', {
      amount: '4', tax: '-1', asset_class: 'STOCK', symbol: 'US0000000001',
      transaction_id: 'dividend',
    }),
    row('TAX_OPTIMIZATION', { tax: '-2', transaction_id: 'tax' }),
    row('INTEREST_PAYMENT', { amount: '1', transaction_id: 'interest' }),
    row('BENEFITS_SAVEBACK', { amount: '3', transaction_id: 'saveback' }),
    row('CARD_TRANSACTION', { amount: '-10', mcc_code: '5999', transaction_id: 'spending' }),
    row('CARD_TRANSACTION', { amount: '-5', mcc_code: '6211', transaction_id: 'investing-card' }),
    row('CARD_TRANSACTION', { amount: '-7', mcc_code: '0000', transaction_id: 'unknown-card' }),
    row('MIGRATION', {
      datetime: '2024-02-03T12:00:00Z', date: '2024-02-03',
      category: 'DELIVERY', asset_class: 'FUND', name: 'Example Fund', symbol: 'IE000TEST0001',
      shares: '4', transaction_id: 'migration',
    }),
  ];
  const settings = {
    assets: [{
      isin: 'IE000TEST0001', name: 'Example Fund', portfolio: 'CORE', targetWeight: 100,
    }],
    cryptoMap: {},
    mccRules: { '5999': 'Spese', '6211': 'Investimenti' },
    defaultAccount: 'Spese',
    expensesOpening: 100,
    emergencyOpening: 50,
  };
  const result = derivePortfolio([{
    id: 'sample', name: 'sample.csv', content: csv(operations),
  }], settings);
  assert.equal(result.groupedAssets[0].shares, 5.5);
  assert.equal(result.groupedAssets[0].marketValue, 660);
  assert.equal(result.investmentCash, 858);
  assert.equal(result.expenseCash, 83);
  assert.equal(result.emergencyCash, 50);
  assert.equal(result.investmentsValue, 1518);
  assert.equal(result.totalValue, 1651);
  assert.equal(result.migrationCount, 1);
});

test('applies outbound instant transfers to investment cash', () => {
  const result = derivePortfolio([{
    id: 'sample',
    name: 'sample.csv',
    content: csv([
      row('TRANSFER_INSTANT_INBOUND', { amount: '100', transaction_id: 'inbound' }),
      row('TRANSFER_INSTANT_OUTBOUND', { amount: '-15', transaction_id: 'outbound' }),
    ]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  assert.equal(result.investmentCash, 85);
  assert.deepEqual(result.cashflows.map(({ type, amount }) => ({ type, amount })), [
    { type: 'TRANSFER_INSTANT_INBOUND', amount: 100 },
    { type: 'TRANSFER_INSTANT_OUTBOUND', amount: -15 },
  ]);
});

test('reallocates CSV liquidity to savings and emergency balances without double counting', () => {
  const result = {
    investmentCash: 2920.9,
    expenseCash: -664.44,
    emergencyCash: 0,
    coreValue: 10952.17,
    satelliteValue: 650.61,
    unassignedValue: 0,
    investmentsValue: 14523.68,
    totalValue: 13859.24,
  };

  const reconciled = reconcileLiquidityBalances(result, {
    risparmiBalance: 815.67,
    emergencyBalance: 0,
  });

  assert.equal(reconciled.investmentCash, 1440.79);
  assert.equal(reconciled.investmentsValue, 13043.57);
  assert.equal(reconciled.risparmiCash, 815.67);
  assert.equal(reconciled.expenseCash, 815.67);
  assert.equal(reconciled.totalValue, 13859.24);
});

test('allocation validation reports incomplete asset targets within a non-empty section', () => {
  const allocations = validateAllocations([
    { portfolio: 'CORE', targetWeight: 7.6 },
    { portfolio: 'CORE', targetWeight: 45 },
    { portfolio: 'CORE', targetWeight: 7.3 },
    { portfolio: 'CORE', targetWeight: 5.6 },
    { portfolio: 'CORE', targetWeight: 0.8 },
    { portfolio: 'CORE', targetWeight: 14.9 },
    { portfolio: 'CORE', targetWeight: 5.5 },
  ], { CORE: 100, SATELLITE: 0 });

  assert.deepEqual(allocations, [
    { portfolio: 'CORE', sum: 86.7, target: 100, valid: false },
    { portfolio: 'SATELLITE', sum: 0, target: 0, valid: true },
  ]);
});

test('absolute asset targets validate against their assigned section weights', () => {
  const allocations = validateAllocations([
    { portfolio: 'CORE', targetWeight: 5.5 },
    { portfolio: 'CORE', targetWeight: 32.4 },
    { portfolio: 'CORE', targetWeight: 5.3 },
    { portfolio: 'CORE', targetWeight: 4.1 },
    { portfolio: 'CORE', targetWeight: 0.6 },
    { portfolio: 'CORE', targetWeight: 10.4 },
    { portfolio: 'CORE', targetWeight: 4.1 },
  ], { CORE: 62.4, SATELLITE: 0 });
  assert.equal(allocations[0].valid, true);
  assert.ok(Math.abs(allocations[0].sum - 62.4) < 1e-10);
  assert.equal(allocations[1].valid, true);
});

test('allocation validation checks asset percentages against each section target', () => {
  const weights = [7.6, 45, 7.3, 5.6, 0.8, 14.9, 5.5];
  const configuration = {
    CORE: { targetWeight: 62.4, assetWeights: weights },
    SATELLITE: { targetWeight: 0, assetWeights: [] },
    CASH: { targetWeight: 37.6, assetWeights: [37.6] },
  };

  const invalid = validateAllocationConfiguration(configuration);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.sectionWeightsValid, true);
  assert.equal(invalid.sections.find(({ portfolio }) => portfolio === 'CORE').assetWeightSum, 86.7);
  assert.equal(invalid.sections.find(({ portfolio }) => portfolio === 'CORE').distributionValid, false);

  const corrected = validateAllocationConfiguration({
    ...configuration,
    CORE: { ...configuration.CORE, assetWeights: [5.5, 32.4, 5.3, 4.1, 0.6, 10.4, 4.1] },
  });
  assert.equal(corrected.valid, true);
});

test('allocation validation rejects negative and over-100 percent targets', () => {
  const invalid = validateAllocationConfiguration({
    CORE: { targetWeight: 100, assetWeights: [-10, 110] },
    SATELLITE: { targetWeight: 0, assetWeights: [] },
    CASH: { targetWeight: 0, assetWeights: [] },
  });
  assert.equal(invalid.sectionWeightsValid, true);
  assert.equal(invalid.sections[0].distributionValid, false);
  assert.equal(invalid.valid, false);

  const invalidSections = validateAllocationConfiguration({
    CORE: { targetWeight: -10, assetWeights: [] },
    SATELLITE: { targetWeight: 110, assetWeights: [] },
    CASH: { targetWeight: 0, assetWeights: [] },
  });
  assert.equal(invalidSections.sectionWeightsValid, true);
  assert.equal(invalidSections.sectionWeightsInRange, false);
  assert.equal(invalidSections.valid, false);

  const overAssetTarget = validateAllocationConfiguration({
    CORE: { targetWeight: 100, assetWeights: [100.05] },
    SATELLITE: { targetWeight: 0, assetWeights: [] },
    CASH: { targetWeight: 0, assetWeights: [] },
  });
  assert.equal(overAssetTarget.sections[0].distributionValid, false);
  assert.equal(overAssetTarget.valid, false);

  const overPortfolioTotal = validateAllocationConfiguration({
    CORE: { targetWeight: 50.05, assetWeights: [50.05] },
    SATELLITE: { targetWeight: 50, assetWeights: [50] },
    CASH: { targetWeight: 0, assetWeights: [] },
  });
  assert.equal(overPortfolioTotal.sectionWeightsValid, false);
  assert.equal(overPortfolioTotal.valid, false);

  const invalidLegacyAssetTargets = validateAllocations([
    { portfolio: 'CORE', targetWeight: -1 },
    { portfolio: 'CORE', targetWeight: 101 },
  ], { CORE: 100, SATELLITE: 0 });
  assert.equal(invalidLegacyAssetTargets[0].valid, false);
});

test('normalizes initial section targets without negative weights', () => {
  assert.deepEqual(normalizeSectionWeights({ CORE: 100, SATELLITE: 50, CASH: -50 }), {
    CORE: 66.7,
    SATELLITE: 33.3,
    CASH: 0,
  });
  assert.deepEqual(normalizeSectionWeights({ CORE: -20, SATELLITE: -5, CASH: 0 }), {
    CORE: 0,
    SATELLITE: 0,
    CASH: 100,
  });
});

test('rebalance trades bring a fully allocated portfolio back to HOLD', () => {
  const settings = {
    assets: [
      { isin: 'IE000CORE0001', name: 'Core One', portfolio: 'CORE', targetWeight: 40 },
      { isin: 'IE000CORE0002', name: 'Core Two', portfolio: 'CORE', targetWeight: 40 },
    ],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  };
  const openingRows = [
    row('CUSTOMER_INBOUND', { amount: '1000', transaction_id: 'opening' }),
    row('BUY', {
      datetime: '2026-09-02T12:00:00Z', date: '2026-09-02',
      category: 'TRADING', asset_class: 'FUND', name: 'Core One',
      symbol: 'IE000CORE0001', shares: '5', price: '100', amount: '-500',
      transaction_id: 'core-one',
    }),
    row('BUY', {
      datetime: '2026-09-03T12:00:00Z', date: '2026-09-03',
      category: 'TRADING', asset_class: 'FUND', name: 'Core Two',
      symbol: 'IE000CORE0002', shares: '3', price: '100', amount: '-300',
      transaction_id: 'core-two',
    }),
  ];
  const opening = derivePortfolio([{
    id: 'history', name: 'history.csv', content: csv(openingRows),
  }], settings);
  const sectionTarget = 80;
  const cashTarget = 20;
  const metricsFor = (result, isin, targetWeightA, sectionValue, targetSection) => {
    const asset = result.groupedAssets.find((item) => item.identifier === isin);
    return calculateRebalancingMetrics({
      assetValue: asset?.marketValue ?? 0,
      portfolioValue: sectionValue,
      investmentValue: result.investmentsValue,
      sectionTarget: targetSection,
      targetWeight: targetWeightA / targetSection * 100,
      thresholdAP: 3,
      thresholdA: 5,
    });
  };

  const initialMetrics = [
    metricsFor(opening, 'IE000CORE0001', 40, opening.coreValue, sectionTarget),
    metricsFor(opening, 'IE000CORE0002', 40, opening.coreValue, sectionTarget),
  ];
  assert.deepEqual(initialMetrics.map(({ status }) => status), ['SELL', 'BUY']);

  const tradeRows = initialMetrics.map((metrics, index) => {
    const isin = `IE000CORE000${index + 1}`;
    const current = opening.groupedAssets.find((asset) => asset.identifier === isin);
    const value = Math.abs(metrics.deltaEuro);
    const shares = value / current.price;
    const isBuy = metrics.status === 'BUY';
    return row(isBuy ? 'BUY' : 'SELL', {
      datetime: `2026-10-05T12:0${index}:00Z`,
      date: '2026-10-05',
      category: 'TRADING',
      asset_class: 'FUND',
      name: current.name,
      symbol: isin,
      shares: String(isBuy ? shares : -shares),
      price: String(current.price),
      amount: String(isBuy ? -value : value),
      transaction_id: `october-${isin}`,
    });
  });
  const after = derivePortfolio([{
    id: 'all', name: 'all.csv', content: csv([...openingRows, ...tradeRows]),
  }], settings);

  const finalAssetMetrics = [
    metricsFor(after, 'IE000CORE0001', 40, after.coreValue, sectionTarget),
    metricsFor(after, 'IE000CORE0002', 40, after.coreValue, sectionTarget),
  ];
  const finalCashMetrics = calculateRebalancingMetrics({
    assetValue: after.investmentCash,
    portfolioValue: after.investmentCash,
    investmentValue: after.investmentsValue,
    sectionTarget: cashTarget,
    targetWeight: 100,
    thresholdAP: 3,
    thresholdA: 5,
  });
  assert.deepEqual(finalAssetMetrics.map(({ status }) => status), ['HOLD', 'HOLD']);
  assert.equal(finalCashMetrics.status, 'HOLD');
  assert.ok(Math.abs(after.investmentCash - 200) < 1e-8);
});

test('deduplicates transaction IDs and resolves crypto ticker mappings', () => {
  const inbound = row('CUSTOMER_INBOUND', { amount: '25', transaction_id: 'same-id' });
  const cryptoBuy = row('BUY', {
    category: 'TRADING', asset_class: 'CRYPTO', name: 'Polkadot', symbol: 'DOT',
    shares: '2', price: '5', amount: '-10', transaction_id: 'crypto-buy',
  });
  const result = derivePortfolio([
    { id: 'first', name: 'first.csv', content: csv([inbound, cryptoBuy]) },
    { id: 'second', name: 'second.csv', content: csv([inbound]) },
  ], {
    assets: [{ isin: 'CRYPTO_DOT', name: 'Polkadot', ticker: 'DOT', portfolio: 'SATELLITE', targetWeight: 100 }],
    cryptoMap: { DOT: 'CRYPTO_DOT' },
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  assert.equal(result.investmentCash, 15);
  assert.equal(result.groupedAssets[0].id, 'CRYPTO_DOT');
  assert.equal(result.groupedAssets[0].portfolio, 'SATELLITE');
  assert.equal(result.importStats[1].duplicates, 1);
});

test('builds full-year liquidity averages and year-end balances from CSV flows', () => {
  const rows = [
    row('CUSTOMER_INBOUND', { amount: '1000', transaction_id: 'opening' }),
    row('BUY', {
      datetime: '2024-01-02T12:00:00Z', date: '2024-01-02',
      category: 'TRADING', asset_class: 'FUND', name: 'Example Fund',
      symbol: 'IE000TEST0001', shares: '2', price: '100', amount: '-200',
      fee: '-1', transaction_id: 'buy',
    }),
    row('CARD_TRANSACTION', {
      datetime: '2024-01-03T12:00:00Z', date: '2024-01-03',
      amount: '-10', transaction_id: 'spend',
    }),
  ];
  const result = derivePortfolio([{ id: 'sample', name: 'sample.csv', content: csv(rows) }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, 2024);
  assert.equal(report.valid, true);
  assert.equal(report.days, 366);
  assert.equal(report.liquidityClosing, 789);
  assert.equal(report.securitiesClosing, 200);
  assert.equal(report.averageLiquidity, (1000 + 799 + 364 * 789) / 366);
});

test('rejects annual reports with no transactions for the requested year', () => {
  const result = derivePortfolio([{
    id: 'sample',
    name: 'sample.csv',
    content: csv([row('CUSTOMER_INBOUND', {
      date: '2023-12-31',
      datetime: '2023-12-31T12:00:00Z',
      amount: '100',
      transaction_id: 'prior-year',
    })]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, 2024);
  assert.equal(report.valid, false);
  assert.match(report.reason, /Non ci sono operazioni CSV per il 2024/);
});

test('rejects annual reports when a held position has no CSV price', () => {
  const result = derivePortfolio([{
    id: 'sample',
    name: 'sample.csv',
    content: csv([
      row('CUSTOMER_INBOUND', { amount: '100', transaction_id: 'inbound' }),
      row('MIGRATION', {
        datetime: '2024-01-02T12:00:00Z', date: '2024-01-02',
        category: 'DELIVERY', asset_class: 'FUND', name: 'Unpriced Fund',
        symbol: 'IE000UNPRICED', shares: '1', transaction_id: 'migration',
      }),
    ]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, 2024);
  assert.equal(report.valid, false);
  assert.match(report.reason, /Prezzo CSV mancante per Unpriced Fund/);
});

test('rejects annual reports when a priced position is net short at year end', () => {
  const result = derivePortfolio([{
    id: 'sample',
    name: 'sample.csv',
    content: csv([
      row('CUSTOMER_INBOUND', { amount: '100', transaction_id: 'inbound' }),
      row('SELL', {
        datetime: '2024-01-02T12:00:00Z', date: '2024-01-02',
        category: 'TRADING', asset_class: 'FUND', name: 'Short Fund',
        symbol: 'IE000SHORT', shares: '-2', price: '10', amount: '20',
        transaction_id: 'oversell',
      }),
    ]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, 2024);
  assert.equal(report.valid, false);
  assert.match(report.reason, /conto titoli al 31\/12 risulta negativo/);
});

test('refuses annual liquidity reports when CSV flows imply an opening balance is missing', () => {
  const result = derivePortfolio([{
    id: 'sample',
    name: 'sample.csv',
    content: csv([row('CARD_TRANSACTION', { amount: '-25', transaction_id: 'spend' })]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, 2024);
  assert.equal(report.valid, false);
  assert.match(report.reason, /dall'apertura del conto/);
});

test('rejects annual reports when prior-year flows already imply a negative opening balance', () => {
  const result = derivePortfolio([{
    id: 'sample',
    name: 'sample.csv',
    content: csv([
      row('CARD_TRANSACTION', {
        date: '2023-12-31', datetime: '2023-12-31T12:00:00Z',
        amount: '-25', transaction_id: 'prior-year-spend',
      }),
      row('CUSTOMER_INBOUND', {
        date: '2024-01-02', datetime: '2024-01-02T12:00:00Z',
        amount: '50', transaction_id: 'current-year-inbound',
      }),
    ]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, 2024);
  assert.equal(report.valid, false);
  assert.match(report.reason, /saldo liquido ricostruito diventa negativo il 2023-12-31/);
});

test('carries the verified prior-year liquidity into the annual average', () => {
  const rows = [
    row('CUSTOMER_INBOUND', {
      date: '2023-01-01', datetime: '2023-01-01T12:00:00Z',
      amount: '500', transaction_id: 'opening',
    }),
    row('CARD_TRANSACTION', {
      date: '2024-01-01', datetime: '2024-01-01T12:00:00Z',
      amount: '-100', transaction_id: 'spend',
    }),
  ];
  const result = derivePortfolio([{ id: 'sample', name: 'sample.csv', content: csv(rows) }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, 2024);
  assert.equal(report.valid, true);
  assert.equal(report.averageLiquidity, 400);
  assert.equal(report.liquidityClosing, 400);
});

test('does not issue an annual 31/12 report before the year has ended', () => {
  const year = new Date().getFullYear();
  const result = derivePortfolio([{
    id: 'sample',
    name: 'sample.csv',
    content: csv([row('CUSTOMER_INBOUND', {
      date: `${year}-01-01`,
      datetime: `${year}-01-01T12:00:00Z`,
      amount: '100',
      transaction_id: 'inbound',
    })]),
  }], {
    assets: [],
    cryptoMap: {},
    mccRules: {},
    expensesOpening: 0,
    emergencyOpening: 0,
  });
  const report = buildAnnualBalanceReport(result, year);
  assert.equal(report.valid, false);
  assert.match(report.reason, /non è ancora concluso/);
});

test('validates absolute allocation sums and Italian number input', () => {
  assert.deepEqual(validateAllocations([
    { portfolio: 'CORE', targetWeight: 60 },
    { portfolio: 'CORE', targetWeight: 40 },
    { portfolio: 'SATELLITE', targetWeight: 100 },
  ], { CORE: 100, SATELLITE: 100 }).map((item) => item.valid), [true, true]);
  assert.equal(validateAllocations([], { CORE: 0, SATELLITE: 0 }).every((item) => item.valid), true);
  assert.equal(parseLocaleNumber('1.234,56'), 1234.56);
  assert.equal(parseLocaleNumber('1234.56'), 1234.56);
  assert.equal(parseLocaleNumber('non numerico'), 0);
  assert.equal(parseLocaleNumber(12.5), 12.5);
  assert.equal(formatCurrency(-0.001), formatCurrency(0));
  assert.equal(formatNumber(Number.NaN), '0');
});

test('rebalancing metrics handle zero values and threshold boundaries', () => {
  const empty = calculateRebalancingMetrics({
    assetValue: 0,
    portfolioValue: 0,
    investmentValue: 0,
    sectionTarget: 0,
    targetWeight: 100,
    thresholdAP: 3,
    thresholdA: 5,
  });
  // Correzione v1.2-QA: con ΔEUR nullo non c'è nulla da vendere; prima risultava 'SELL'.
  assert.deepEqual(empty, {
    deltaAP: -100,
    deltaA: 0,
    targetEuro: 0,
    deltaEuro: 0,
    status: 'HOLD',
  });
  const atThreshold = calculateRebalancingMetrics({
    assetValue: 95,
    portfolioValue: 100,
    investmentValue: 100,
    sectionTarget: 100,
    targetWeight: 100,
    thresholdAP: 5,
    thresholdA: 5,
  });
  assert.equal(atThreshold.deltaAP, -5);
  assert.equal(atThreshold.deltaA, -5);
  assert.equal(atThreshold.status, 'HOLD');
});

test('rebalancing: banda relativa al target e importo minimo', () => {
  const small = {
    assetValue: 200,
    portfolioValue: 10000,
    investmentValue: 10000,
    sectionTarget: 100,
    targetWeight: 1,
    thresholdAP: 0.5,
    thresholdA: 0.5,
  };
  assert.equal(calculateRebalancingMetrics(small).status, 'SELL');
  assert.equal(calculateRebalancingMetrics({ ...small, thresholdRelative: 150 }).status, 'HOLD');
  assert.equal(calculateRebalancingMetrics({ ...small, thresholdRelative: 50 }).status, 'SELL');
  assert.equal(calculateRebalancingMetrics({ ...small, minAmount: 150 }).status, 'HOLD');
  assert.equal(calculateRebalancingMetrics({ ...small, minAmount: 50 }).status, 'SELL');
});
