# Linee guida CSV — Portfolio Manager

## Importazione e archivio

Il pulsante di caricamento nell'Archivio importa uno o più registri CSV. Un file senza le intestazioni richieste o senza alcuna riga valida viene rifiutato e non entra nell'archivio; i file non `.csv` o oltre 10 MB sono rifiutati con un messaggio. I file restano separati, possono essere ordinati con il drag-and-drop o eliminati con il pulsante già presente. In caso di `transaction_id` duplicato prevale il primo file nell'ordine corrente; l'ordine (inizialmente quello di caricamento) è salvato per profilo e resta invariato dopo ricarica o riavvio. I saldi Risparmi ed Emergenze inseriti nell'Archivio sono quote della liquidità complessiva ricostruita dai CSV: la liquidità Investimenti viene ridotta dello stesso importo per evitare doppi conteggi.

Il mese di un export consolidato è ricavato dalla data dell'ultima operazione. Per i file mensili il nome convenzionale `<MMM>_<AA>.csv` determina l'etichetta. L'ordinamento e l'etichetta non alterano le date e l'ordine cronologico delle operazioni.

I CSV sono salvati dal server locale in `server/data/csv/<id-utente>/`; configurazioni, ordine dei file, saldi inseriti nell'Archivio e prezzi manuali sono in `server/data/state/<id-utente>.json`, per profilo: il browser non salva dati. Una tantum, i dati che versioni precedenti tenevano nel `localStorage` vengono riportati sul server e rimossi dal browser. Al primo avvio l'archivio e le tabelle non contengono dati: vengono popolati solo dopo l'importazione dei CSV.

## Formato

Formato UTF-8, separatore virgola, virgolette RFC 4180, intestazione e decimali con punto. Colonne richieste:

`datetime`, `date`, `category`, `type`, `asset_class`, `name`, `symbol`, `shares`, `price`, `amount`, `fee`, `tax`, `currency`, `fx_rate`, `transaction_id`, `mcc_code`.

I campi vuoti numerici valgono zero. Colonne aggiuntive del CSV Trade Republic, come `description`, `counterparty_name` e `original_currency`, non modificano i calcoli.

## Tipi di operazione e calcoli

| Tipo | Effetto sulle posizioni | Effetto sulla cassa |
|---|---|---|
| `BUY` | Aggiunge `shares` all'asset identificato da `symbol`/ISIN. | Investimenti: `amount + fee + tax`. |
| `SELL` | Somma `shares`, normalmente negativo. | Investimenti: `amount + fee + tax`. |
| `MIGRATION` | Applica `shares` all'asset; i trasferimenti in uscita/entrata dello stesso asset si compensano. | Nessuno. |
| `CUSTOMER_INBOUND`, `TRANSFER_INBOUND`, `TRANSFER_INSTANT_INBOUND` | Nessuno. | Investimenti: `amount`. |
| `CUSTOMER_OUTBOUND_REQUEST` | Nessuno. | Prelievo da Investimenti: `amount` (deve essere negativo). |
| `TRANSFER_OUTBOUND`, `TRANSFER_INSTANT_OUTBOUND` | Nessuno. | Investimenti: `amount` (normalmente negativo). |
| `INTEREST_PAYMENT` | Nessuno. | Investimenti: `amount`. |
| `DIVIDEND` | `shares` è solo informativo. | Investimenti: `amount + tax`. |
| `BENEFITS_SAVEBACK` | Nessuno. | Investimenti: `amount`. |
| `TAX_OPTIMIZATION` | Nessuno. | Investimenti: `tax`. |
| `CARD_TRANSACTION` | Nessuno. | Contribuisce ai flussi di liquidità secondo il mapping MCC; non imposta i saldi manuali Risparmi o Emergenze. La quota non assegnata a saldi manuali resta in Cash Investimenti. |

`transaction_id` viene usato per ignorare righe duplicate tra file. Le date dei movimenti determinano l'ordine di accumulo, a prescindere dall'ordine di caricamento.

I saldi Risparmi ed Emergenze dell'Archivio sono inseriti manualmente: una cella vuota equivale a zero e non viene ricavata dalle transazioni CSV; se più file hanno un valore, vale quello dell'ultimo file nell'ordine corrente. La liquidità CSV non assegnata a questi saldi resta in Cash Investimenti, senza doppio conteggio. Gli importi accettano il formato italiano (`1.500`, `1.234,56`). I valori Corrente e Risparmi precedentemente salvati vengono sommati una sola volta nel nuovo saldo Risparmi.

Le righe vengono validate rispetto alle intestazioni, alle date ISO (giorni di calendario reali e timestamp con fuso orario), agli identificativi, ai tipi di operazione supportati, alle categorie e ai campi numerici. BUY richiede quote positive e importo negativo; SELL richiede quote negative e importo positivo; `CUSTOMER_OUTBOUND_REQUEST` richiede `amount` negativo. Per questo prelievo si contabilizza solo `amount`, senza aggiungere `fee` o `tax`. Un file privo di righe valide viene rifiutato; gli errori sono mostrati all'utente. Un tipo non riconosciuto non viene ignorato silenziosamente.

## Asset e valutazione

Per FUND, STOCK e BOND, `symbol` è l'ISIN e identifica l'asset. Per CRYPTO, `symbol` è il ticker e l'app usa la mappatura definita in `src/data/crypto_isin_map.json`. Gli asset non configurati sono inseriti nella tabella Allocazione secondo la regola descritta in `guidelinesCC.md`.

```text
quote correnti = somma cronologica delle shares di BUY e SELL
valore stimato = quote correnti × prezzo osservato al caricamento del CSV più recente
```

Al caricamento di ogni CSV il server recupera da Yahoo Finance (endpoint non ufficiale), per ogni ISIN negoziato nel file, l'ultima chiusura fino alla fine del mese dell'ultima operazione (al massimo oggi). Si preferiscono le sedi in euro (Xetra, Francoforte, Monaco, Stoccarda, Milano, Parigi, Amsterdam); le altre valute sono convertite in euro al cambio del giorno. Il risultato (data di estrazione e prezzi) è in `server/data/prices/<id-utente>/<csv>.json`, legato al CSV: eliminando il CSV si elimina il file e tornano validi i prezzi del CSV precedente. Non c'è aggiornamento successivo. Gli asset non risolti (e le crypto) restano all'ultimo prezzo BUY/SELL del CSV; i prezzi si possono correggere nella colonna Prezzo € di Rebalancing, salvata sul CSV più recente.

I prezzi sono quelli di borsa e differiscono di poco da quelli del broker (nei dati di prova, entro lo 0,7% per titolo). I valori restano stime. Il report Giacenza Media usa ancora i prezzi presenti nell'export.

## MCC

Il file `src/data/mcc_mapping.json` contiene le regole iniziali (`mcc_rules`) e il conto di default per i codici non mappati (`default_conto`). Gli MCC 5310 e 6211 classificano i flussi carta come Investimenti; gli altri codici, inclusi quelli non mappati, li classificano come Spese. Questa classificazione non calcola né modifica i saldi manuali Risparmi ed Emergenze: tali valori si inseriscono nell'Archivio e una cella vuota vale zero. Gli importi delle carte continuano a concorrere alla liquidità complessiva ricostruita dai CSV.

## PDF Giacenza Media

Dopo l'importazione, l'Archivio elenca gli anni conclusi coperti dai CSV. Il PDF `GM_<AA>.pdf` riporta la giacenza media della liquidità complessiva, il valore stimato del conto titoli al 31/12 e la liquidità complessiva al 31/12. La media considera tutti i giorni dell'anno. I movimenti vengono ricostruiti dal saldo zero e aggregati tra i conti; se i flussi producono un saldo negativo, il PDF non viene generato e l'app segnala che manca parte dello storico dall'apertura del conto. L'anno in corso non viene pubblicato prima del 31/12. Il valore titoli usa le quote al 31/12 e l'ultimo prezzo CSV disponibile fino a quella data (anche di anni precedenti, se nell'anno non ci sono operazioni sull'asset). Il documento è un report deterministico stimato, non un certificato ufficiale Trade Republic.
