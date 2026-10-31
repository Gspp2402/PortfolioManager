import { parseCsv } from '../src/js/portfolio-engine.js';

const YAHOO = 'https://query2.finance.yahoo.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' };
// Sedi tedesche/europee in euro, in ordine di preferenza (Xetra per prima).
const EXCHANGE_SUFFIXES = ['.DE', '.F', '.MU', '.SG', '.MI', '.PA', '.AS'];
const symbolCache = new Map();

async function getJson(url) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function candidateSymbols(isin) {
  const data = await getJson(`${YAHOO}/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=15&newsCount=0`);
  const symbols = (data.quotes ?? []).map((quote) => quote.symbol).filter(Boolean);
  const rank = (symbol) => {
    const index = EXCHANGE_SUFFIXES.findIndex((suffix) => symbol.endsWith(suffix));
    return index < 0 ? EXCHANGE_SUFFIXES.length : index;
  };
  return symbols.sort((a, b) => rank(a) - rank(b));
}

// Ultima chiusura con data <= asOf (YYYY-MM-DD), nella valuta di quotazione.
async function closeOnOrBefore(symbol, asOf) {
  const end = Date.parse(`${asOf}T00:00:00Z`) / 1000 + 86400;
  const start = end - 10 * 86400;
  const data = await getJson(`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d`);
  const chart = data.chart?.result?.[0];
  const closes = chart?.indicators?.quote?.[0]?.close ?? [];
  const timestamps = chart?.timestamp ?? [];
  for (let index = timestamps.length - 1; index >= 0; index -= 1) {
    const day = new Date(timestamps[index] * 1000).toISOString().slice(0, 10);
    if (day <= asOf && closes[index] > 0) return { close: closes[index], currency: chart.meta.currency };
  }
  return null;
}

async function toEur({ close, currency }, asOf) {
  if (currency === 'EUR') return close;
  const [code, divisor] = currency === 'GBp' ? ['GBP', 100] : [currency, 1];
  const fx = await closeOnOrBefore(`EUR${code}=X`, asOf);
  return fx ? close / divisor / fx.close : null;
}

async function priceForIsin(isin, asOf) {
  const known = symbolCache.get(isin);
  for (const symbol of known ? [known] : await candidateSymbols(isin)) {
    try {
      const quote = await closeOnOrBefore(symbol, asOf);
      const price = quote && await toEur(quote, asOf);
      if (price != null) {
        symbolCache.set(isin, symbol);
        return price;
      }
    } catch {
      // simbolo senza dati: prova il successivo
    }
  }
  return null;
}

// Fine mese dell'ultima operazione del CSV, limitata a oggi.
function priceDateForCsv(content, today = new Date()) {
  const lastDate = parseCsv(content).rows.reduce((latest, row) => (row.date > latest ? row.date : latest), '');
  const monthEnd = new Date(Date.UTC(Number(lastDate.slice(0, 4)), Number(lastDate.slice(5, 7)), 0))
    .toISOString().slice(0, 10);
  return monthEnd < today.toISOString().slice(0, 10) ? monthEnd : today.toISOString().slice(0, 10);
}

// Prezzi alla data di estrazione; gli asset non risolti vengono omessi (si possono inserire a mano).
export async function fetchPricesForCsv(content) {
  if (process.env.PORTFOLIO_SKIP_PRICES) throw new Error('estrazione prezzi disattivata');
  const { rows } = parseCsv(content);
  const isins = [...new Set(rows
    .filter((row) => ['BUY', 'SELL', 'MIGRATION'].includes(row.type) && row.asset_class !== 'CRYPTO')
    .map((row) => row.symbol))];
  const asOf = priceDateForCsv(content);
  const prices = {};
  await Promise.all(isins.map(async (isin) => {
    try {
      const price = await priceForIsin(isin, asOf);
      if (price != null) prices[isin] = Math.round(price * 1e4) / 1e4;
    } catch (error) {
      console.warn(`Prezzo non disponibile per ${isin}: ${error.message}`);
    }
  }));
  return { asOf, fetchedAt: new Date().toISOString(), prices };
}
