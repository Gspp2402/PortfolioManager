# CSV sintetici di collaudo

Tutti i file sono **fittizi**: nomi, ISIN (`SYN0…`), ticker (`SYNC`) e
`transaction_id` (`syn-…`) non corrispondono a persone, conti o titoli reali.
Formato: UTF-8, virgola, intestazioni esatte di `guidelinesCSV.md`, quoting RFC 4180.
Non aggiungere mai qui CSV reali.

## `valid/` — risultati attesi calcolati a mano

| File | Contenuto |
|---|---|
| `SYN_GEN_25.csv` | Versamento 10.000; BUY FUND (nome con virgola e virgolette), BOND, STOCK in USD (`fx_rate` 0,9), CRYPTO; CARD_TRANSACTION con MCC 5812, 5310, 6211, 9999 (non mappato); interessi 5,5 (`syn-a10`); un timestamp con fuso `+01:00`. |
| `SYN_FEB_25.csv` | DIVIDEND con ritenuta, SELL, MIGRATION senza prezzo seguita da BUY, TAX_OPTIMIZATION, TRANSFER_INSTANT_OUTBOUND, SAVEBACK; **duplicato deliberato** di `syn-a10` con importo 999. |
| `SYN_DIC_25.csv` | Righe fuori ordine cronologico; TRANSFER_INBOUND a dicembre 2025 e BUY di un asset nuovo a gennaio 2026 (asset non ancora configurato). |

Con ordine GEN → FEB → DIC (MCC da `src/data/mcc_mapping.json`):

- operazioni usate 19 (20 righe valide, 1 duplicato); duplicati per file `[0, 1, 0]`;
- cassa Investimenti 4.764,10 €; Risparmi −90,00 € (MCC 5812 e 9999); totale liquidità 4.674,10 €;
- titoli 6.200,00 € (fondo 40 × 110; bond 10 × 100; azione USD 10 × 45; crypto `CRYPTO_SYNC` 2 × 100; fondo migrato 6 × 20; azione nuova 3 × 10);
- totale conto 10.874,10 €; con FEB prima di GEN prevale il duplicato da 999: totale 11.867,60 €;
- Giacenza 2025: 365 giorni, liquidità al 31/12 4.704,10 €, titoli al 31/12 6.170,00 €; media calcolata nel test con un oracolo giornaliero indipendente.

## `rebalancing/SYN_REBAL.csv`

Conto Investimenti 10.000 €: fondo X 6.000, fondo Y 2.000, azione Z 1.000, cassa 1.000.
I test in `tests/engine-fixtures.test.js` applicano target diversi a questo file:
target esatti (solo HOLD), sopra/sotto soglia, solo BUY, solo SELL, asset a peso zero,
asset non detenuto, soglie personalizzate.

## `invalid/` — un difetto per file

Ogni file contiene al più una riga valida più la riga difettosa, così l'errore atteso è
univoco: intestazione mancante, virgolette non chiuse, colonne in eccesso, data
impossibile, timestamp senza fuso, numero non numerico, valuta senza cambio, segno
incoerente, categoria errata, `transaction_id` mancante, tipo sconosciuto (anche vuoto),
nessuna riga valida, file non CSV. Questi file non sono mai caricati insieme ai fixture
validi, salvo nei test che verificano proprio l'isolamento degli errori.
