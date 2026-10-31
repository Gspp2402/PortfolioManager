# Linee guida — Collaudo e protezione dei dati

## Comandi

```bash
npm test                              # motore, API, profili (node --test)
npm run build                         # build di produzione in dist/
python tests/e2e/e2e_portfolio.py     # browser, dopo npm run build (Playwright per Python)
```

| Suite | File | Cosa copre |
|---|---|---|
| Motore (storica) | `tests/portfolio-engine.test.js` | parsing, validazione, posizioni, cassa, allocazione, Giacenza, ribilanciamento (soglie assolute, relative e importo minimo) |
| Motore su fixture | `tests/engine-fixtures.test.js` | risultati attesi dei CSV sintetici, duplicati e ordine, MCC, split liquidità, errori, ribilanciamento, input italiani |
| API | `tests/server-api.test.js` | profili, archivio CSV, errori di upload, nomi univoci, isolamento, feedback, 404, protezioni solo-locale, `users.json` corrotto, riavvio e arresto |
| Profili | `tests/users.integration.test.js` | tre profili con portafogli indipendenti |
| Browser | `tests/e2e/e2e_portfolio.py` | verifiche sui flussi critici dell'interfaccia (vedi intestazione del file); la finestra Electron non è coperta da test automatici: si verifica a mano che chiudendola il processo e la porta si liberino |

## Regole sui dati

- I test usano solo `tests/fixtures/` (descrizione in `tests/fixtures/README.md`).
- Server avviati dai test: sempre con `PORTFOLIO_DATA_DIR` temporanea, mai `server/data`,
  e con `PORTFOLIO_SKIP_PRICES=1` (nessuna richiesta a Yahoo Finance dai test).
- Test browser: contesto isolato (localStorage vuoto); le richieste verso host non
  locali vengono bloccate e fanno fallire E02/E22.
- CSV reali: mai in fixture, log, screenshot, report o commit; eventuali controlli
  sui dati reali si fanno in locale, in sola lettura, riportando solo conteggi.
- Prima e dopo una sessione di collaudo confrontare gli hash dei CSV reali
  (`sha256sum`) e verificare che `server/data` non contenga file dei test.

## Aggiungere un test

Definire prima il risultato atteso (a mano o con un oracolo indipendente dall'engine),
poi scrivere il test. Un nuovo fixture negativo va in `invalid/` con l'aspettativa
corrispondente nel test `CSV non validi`, che verifica che ogni file abbia la sua.
