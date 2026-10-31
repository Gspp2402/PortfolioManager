# Linee guida — Conti e portafogli

Questa app mantiene la struttura e i controlli del mockup originale, ma parte senza dati dimostrativi. I valori di overview, allocazione, ribilanciamento e Giacenza Media compaiono dai CSV importati.

## Conti

```text
Conto Totale
├── Conto Investimenti
│   ├── Core
│   ├── Satellite
│   └── Cash (EUR)
├── Conto Risparmi
└── Conto Emergenze
```

Il Conto Totale è la somma di Investimenti, Risparmi ed Emergenze. Investimenti è la somma di Core, Satellite e Cash. I saldi Risparmi ed Emergenze dell'Archivio sono manuali: una cella vuota vale zero e non viene calcolata dalle transazioni CSV. La liquidità non assegnata resta in Cash Investimenti; gli importi manuali vengono sottratti da Cash per evitare doppi conteggi.

La precedente suddivisione del conto Spese in Corrente e Risparmi viene migrata una sola volta: il vecchio saldo Corrente viene sommato a Risparmi, mentre Emergenze resta invariato.

## Allocazione e asset

La configurazione degli asset è la tabella **Impostazioni → Allocazione**:

- il peso delle sezioni Core, Satellite e Cash è espresso come percentuale del Conto Investimenti e deve totalizzare 100%;
- per ogni asset si imposta `% (A)`, cioè la percentuale diretta del Conto Investimenti; le percentuali sono così definite sulla base usata per decidere gli importi dei PAC;
- `% (A|P)` è calcolata automaticamente come `% (A) / peso della sezione × 100`;
- la somma degli `% (A)` degli asset di ciascuna sezione deve essere uguale al peso della relativa sezione;
- un'allocazione non valida mostra `!` su Impostazioni/Allocazione e il passaggio del mouse spiega quale somma correggere;
- la riga Cash ha `% (A)` uguale al peso della sezione Cash e `% (A|P)` pari al 100%;
- le righe vuote in fondo a Core e Satellite consentono di aggiungere asset con nome, ISIN e percentuale;
- il drag-and-drop sposta e riordina asset; le azioni di eliminazione rimuovono la configurazione.

Le configurazioni salvate con versioni precedenti vengono convertite automaticamente: il loro target condizionato viene moltiplicato per il peso della sezione per ottenere `% (A)`.

L'identificativo di corrispondenza è l'ISIN. Per crypto, il CSV usa il ticker e la configurazione usa l'ID sintetico corrispondente, ad esempio `CRYPTO_DOT`, definito in `src/data/crypto_isin_map.json`. EUR è la sola posizione Cash.

Quando un asset detenuto non è ancora configurato, la prima importazione lo assegna in modo deterministico a Core se `asset_class` è FUND o BOND e a Satellite negli altri casi; il target iniziale `% (A)` degli asset è proporzionale al loro valore CSV corrente e alla quota assegnata alla sezione. I target restano modificabili nella tabella.

## Cassa

Cash Investimenti parte da zero e si ricostruisce cronologicamente:

- `CUSTOMER_INBOUND`, `TRANSFER_INBOUND`, `TRANSFER_INSTANT_INBOUND`, `INTEREST_PAYMENT`, `BENEFITS_SAVEBACK`: importo `amount`;
- `CUSTOMER_OUTBOUND_REQUEST`: prelievo da Investimenti; `amount` deve essere negativo ed è conteggiato senza `fee` o `tax`;
- `DIVIDEND`: `amount + tax`, con `tax` negativo quando è una ritenuta;
- `TAX_OPTIMIZATION`: importo `tax`;
- `BUY` e `SELL`: `amount + fee + tax`;
- `MIGRATION`: aggiorna le quote trasferite; coppie di trasferimenti in uscita/entrata dello stesso asset si compensano.

Le `CARD_TRANSACTION` contribuiscono alla ricostruzione della liquidità complessiva secondo il mapping MCC: i codici iniziali classificati come Investimenti sono 5310 e 6211; mapping e default sono definiti in `src/data/mcc_mapping.json`. Non determinano però i saldi manuali di Risparmi o Emergenze. Questi si inseriscono nell'Archivio e le celle vuote valgono zero; la liquidità non assegnata resta in Cash Investimenti.

Un Cash Investimenti negativo indica che i flussi importati non bastano a coprire gli acquisti o i saldi manuali assegnati. Può segnalare uno storico CSV iniziale incompleto o saldi manuali superiori alla liquidità ricostruita; non va trasferito automaticamente a Risparmi né corretto inventando un saldo.

## Valori e limiti

Le posizioni sono la somma cronologica delle quote BUY/SELL. Il valore di mercato di ciascun asset usa il prezzo osservato al caricamento del CSV più recente che lo quota (vedi guidelinesCSV.md); in mancanza, l'ultimo prezzo di una transazione CSV. Il ribilanciamento confronta questi valori con i target delle sezioni.

Stato di ogni riga del ribilanciamento: `HOLD` se lo scostamento `Δ(A|P)` è entro la banda (A|P) **e** `Δ(A)` è entro la banda (A), oppure se l'importo da movimentare `Δ €` è inferiore a un centesimo o all'Importo minimo; altrimenti `BUY` se `Δ € > 0` e `SELL` se `Δ € < 0`. Ogni banda è il massimo tra la soglia assoluta in punti percentuali (Soglia (A|P), Soglia (A)) e la Soglia relativa al target, cioè la percentuale del target dell'asset (`% (A|P)` o `% (A)`): serve a evitare ordini inutili sugli asset con target piccolo. Con Soglia relativa e Importo minimo a zero (default) vale solo la soglia assoluta. `Δ €` è sempre calcolato sul Conto Investimenti (`% (A)`), quindi la direzione può differire dal segno di `Δ(A|P)` quando l'intera sezione è fuori target. Le soglie negative sono trattate come zero. Le soglie sono salvate per profilo.

I CSV importati sono conservati sul server locale, in `server/data/csv/<id-utente>/`;
i profili sono in `server/data/users.json`. Allocazioni, soglie, saldi, ordine dei CSV
e prezzi manuali sono in `server/data/state/<id-utente>.json`, i prezzi estratti al
caricamento in `server/data/prices/<id-utente>/`: il browser non salva nulla. Questi profili non
implementano autenticazione o controllo degli accessi.
