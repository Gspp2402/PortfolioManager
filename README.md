# Portfolio Manager

Dashboard locale per ricostruire un portafoglio Trade Republic dai CSV delle
operazioni. L'app parte senza dati di portafoglio: posizioni, liquidità,
allocazione, ribilanciamento e report vengono calcolati dai CSV importati e
dalle impostazioni inserite nell'interfaccia.

## Nota sullo sviluppo

Questa applicazione **non è stata programmata autonomamente dall'autore**.
È stata realizzata con il supporto operativo di un agente di intelligenza
artificiale: l'implementazione del codice, il debugging e la preparazione dei
test sono stati svolti tramite l'agente, sulla base dei requisiti, delle
indicazioni e delle verifiche dell'autore. Non va quindi presentata come un
progetto sviluppato interamente in autonomia dall'autore.

## Requisiti

- Node.js 18 o successivo
- npm

## Avvio come app desktop

Finestra dedicata (Electron), senza browser e senza terminale: il server gira
nello stesso processo e si ferma quando chiudi la finestra.

```bash
npm install
npm run build            # da ripetere dopo modifiche all'interfaccia
npm run install-launcher # voce "Portfolio Manager" nel menu applicazioni (Linux)
```

Dopo `install-launcher` l'app si avvia dal menu; in alternativa `npm run app`.
Su Linux, se Electron si blocca con l'errore del SUID sandbox (`chrome-sandbox`
non configurato correttamente), avvia con:

```bash
ELECTRON_DISABLE_SANDBOX=1 npm run app
```

I dati restano in `server/data/`. Un secondo avvio riporta in primo piano la
finestra già aperta.

## Avvio in locale (sviluppo)

Da questa cartella:

```bash
npm install
npm run dev
```

Il comando avvia API e interfaccia Vite su `http://localhost:3001`; il server
ascolta solo sull'interfaccia di loopback (`127.0.0.1`). Per fermarlo usa
`Ctrl+C` nel terminale. `npm run dev:ui` avvia solo Vite e
richiede che le API siano già attive su `127.0.0.1:3001`. `npm run build` e
`npm start` servono la versione di produzione da `dist/`.

## Funzioni

- Importazione, riordino e rimozione dei file CSV dall'Archivio.
- Ricostruzione di posizioni, liquidità e valore stimato del portafoglio.
- Configurazione dei target di allocazione, gestione degli asset e calcolo
  degli scostamenti per il ribilanciamento.
- Saldi Risparmi ed Emergenze inseriti manualmente: i campi vuoti valgono zero
  e la liquidità non assegnata resta in Cash Investimenti. I vecchi saldi Corrente
  e Risparmi vengono sommati una sola volta nel nuovo saldo Risparmi.
- Prezzi degli asset estratti automaticamente al caricamento di ogni CSV (fine
  mese, da Yahoo Finance) e legati a quel CSV; correggibili a mano in
  Rebalancing.
- Soglie di ribilanciamento assolute, relative al target e per importo minimo.
- Generazione dei report PDF di Giacenza Media per gli anni conclusi coperti
  dai dati importati.

## Dati e privacy

I CSV importati sono salvati localmente in `server/data/csv/<id-utente>/` e i
profili in `server/data/users.json`; allocazioni, soglie, ordine dei CSV, saldi
Risparmi/Emergenze e prezzi manuali sono in `server/data/state/<id-utente>.json`,
i prezzi estratti in `server/data/prices/<id-utente>/`. Il browser non salva
dati. La cartella `server/data/` e `csvProva/` sono ignorate da Git: non
condividerle e non includerle in archivi dopo aver caricato dati reali. Questa
copia non include CSV reali, dati locali, `node_modules` o file di build.

L'unica comunicazione verso l'esterno è l'estrazione dei prezzi al caricamento
di un CSV: il server invia a Yahoo Finance gli ISIN presenti nel file (nessun
importo, nessun dato personale). Non vengono caricate risorse esterne: i font usano
`Inter`/`JetBrains Mono` solo se installati sul sistema, altrimenti i font di
sistema. I test usano esclusivamente i CSV sintetici di `tests/fixtures/`.

I profili utente sono separazioni locali dei dati, non account con autenticazione
o controllo degli accessi. Il server ascolta solo su `127.0.0.1` e rifiuta
richieste con `Host` o `Origin` non locali (protezione da siti web aperti nello
stesso browser e da DNS rebinding). Questa versione è destinata all'uso locale;
non esporre il server alla rete o a Internet. Per una pubblicazione web servono
un backend e un modello di autenticazione progettati per l'hosting.

## Test e build

```bash
npm test          # motore, API (directory dati temporanea), profili
npm run build
```

Test end-to-end opzionali nel browser (richiedono Playwright per Python, non è
una dipendenza npm del progetto):

```bash
pip install playwright && python -m playwright install chromium
npm run build && python tests/e2e/e2e_portfolio.py
```

Procedura e fixture sono descritti in
[guidelines/guidelinesTest.md](./guidelines/guidelinesTest.md).

## Documentazione

- [Linee guida dell'applicazione](./guidelines/guidelinesCC.md)
- [Formato e interpretazione dei CSV](./guidelines/guidelinesCSV.md)
- [Collaudo, fixture e protezione dei dati](./guidelines/guidelinesTest.md)

## Limiti dei calcoli

Le valutazioni usano i prezzi di chiusura di fine mese estratti al caricamento
dei CSV (o, in mancanza, i prezzi presenti nelle operazioni) e non quotazioni
in tempo reale; possono differire di poco dal broker. Il PDF è un report calcolato dall'applicazione e non un certificato
ufficiale Trade Republic. La Giacenza Media non viene generata se i flussi
disponibili implicano un saldo negativo o uno storico iniziale incompleto.
L'app non costituisce consulenza finanziaria.
