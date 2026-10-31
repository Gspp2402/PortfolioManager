"""Test end-to-end dei flussi critici di Portfolio Manager.

Requisiti (opzionali, non sono dipendenze npm del progetto):
  pip install playwright && python -m playwright install chromium

Uso:
  npm run build
  python tests/e2e/e2e_portfolio.py

Il server viene avviato in produzione su una porta libera, con PORTFOLIO_DATA_DIR
temporanea e un contesto browser isolato (localStorage vuoto). Vengono usati solo
i CSV sintetici di tests/fixtures. Le richieste verso host non locali sono
registrate e bloccate; nessuna email viene inviata.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures"
RESULTS = []


def check(code, description, condition, detail=""):
    RESULTS.append((code, description, bool(condition), detail))
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {code} {description}" + (f" — {detail}" if detail and not condition else ""), flush=True)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_server(data_dir, port):
    env = {**os.environ, "NODE_ENV": "production", "PORT": str(port), "PORTFOLIO_DATA_DIR": str(data_dir), "PORTFOLIO_SKIP_PRICES": "1"}
    proc = subprocess.Popen(["node", "server/index.js"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/users", timeout=1)
            return proc
        except Exception:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("server non avviato")


def text(page, selector):
    return page.locator(selector).first.inner_text().strip()


def asset_row(page, isin):
    """Riga dell'allocazione con l'ISIN dato (il valore è una proprietà, non un attributo)."""
    index = page.evaluate("""(isin) => [...document.querySelectorAll('#allocazione-tbody tr.asset-row')]
        .findIndex(r => [...r.querySelectorAll('input')].some(i => i.value === isin))""", isin)
    return None if index < 0 else page.locator("#allocazione-tbody tr.asset-row").nth(index)


def euro(value):
    """Formato it-IT come Intl.NumberFormat: '10.874,10 €' (spazio unificatore)."""
    return value.replace("\u00a0", " ")


def main():
    data_dir = Path(tempfile.mkdtemp(prefix="pm-e2e-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = start_server(data_dir, port)
    dialogs = []
    external = []
    page_errors = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            context = browser.new_context(accept_downloads=True)
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)

            def route(route_obj):
                host = re.sub(r"^\w+://([^/:]+).*$", r"\1", route_obj.request.url)
                if host not in ("127.0.0.1", "localhost") and not route_obj.request.url.startswith(("data:", "blob:")):
                    external.append(route_obj.request.url)
                    return route_obj.abort()
                return route_obj.continue_()

            context.route("**/*", route)
            page = context.new_page()
            page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
            page.on("pageerror", lambda e: page_errors.append(str(e)))

            # E01 avvio senza dati
            page.goto(base)
            page.wait_for_timeout(500)
            check("E01", "pagina senza dati: totale a zero",
                  euro(text(page, ".total-account span:last-child")) == "0,00 €")

            # E02 richieste di rete esterne (privacy)
            check("E02", "nessuna richiesta verso host esterni al caricamento", not external, ", ".join(external))

            # E03 tab
            page.click("#tab-rebalancing")
            ok = page.locator("#panel-rebalancing.active").count() == 1
            page.click("#tab-overview")
            check("E03", "navigazione tab Overview/Rebalancing", ok and page.locator("#panel-overview.active").count() == 1)

            # E04 modali e navigazione laterale
            page.click("#btn-archive")
            opened = page.locator("#archive-modal-overlay.active").count() == 1
            page.click(".sidebar-nav-item[data-target='archive-pane-giacenza']")
            pane = page.locator("#archive-pane-giacenza.active").count() == 1
            page.click(".sidebar-nav-item[data-target='archive-pane-csv']")
            page.keyboard.press("Escape")
            closed = page.locator("#archive-modal-overlay.active").count() == 0
            page.click("#btn-settings")
            page.click("#settings-modal-close")
            check("E04", "modali: apertura, pannelli laterali, chiusura con Esc e pulsante",
                  opened and pane and closed and page.locator("#settings-modal-overlay.active").count() == 0)

            # E05 upload multiplo
            page.click("#btn-archive")
            dialogs.clear()
            with page.expect_file_chooser() as chooser:
                page.click("#archive-pane-csv .btn-upload")
            chooser.value.set_files([str(FIX / "valid" / n) for n in ("SYN_GEN_25.csv", "SYN_FEB_25.csv", "SYN_DIC_25.csv")])
            page.wait_for_function("document.querySelectorAll('#archive-pane-csv tbody tr.asset-row[data-import-id]').length === 3")
            page.wait_for_timeout(300)
            msg = dialogs[-1] if dialogs else ""
            check("E05a", "upload multiplo: riepilogo con file, duplicati e righe non valide",
                  "3 file importati" in msg and "1 duplicati ignorati" in msg, msg)
            check("E05b", "totale conto atteso dai fixture (10.874,10 €)",
                  euro(text(page, ".total-account span:last-child")) == "10.874,10 €", text(page, ".total-account span:last-child"))
            check("E05c", "Risparmi resta a zero senza saldo manuale; i flussi restano nel totale",
                euro(text(page, ".card.risparmi .card-value")) == "0,00 €"
                and euro(text(page, ".total-account span:last-child")) == "10.874,10 €",
                text(page, ".card.risparmi .card-value"))
            labels = page.locator("#archive-pane-csv .csv-filename").all_text_contents()
            check("E05d", "etichette dei file dal nome/ultima data", labels[:2] == ["GEN_25.csv", "FEB_25.csv"], str(labels))

            # E06 saldi Risparmi/Emergenze modificabili nell'Archivio
            last = page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id]").nth(2)
            last.locator("input[aria-label='Risparmi']").fill("300")
            last.locator("input[aria-label='Risparmi']").press("Tab")
            last.locator("input[aria-label='Emergenze']").fill("1.000")
            last.locator("input[aria-label='Emergenze']").press("Tab")
            page.wait_for_timeout(300)
            risparmi = euro(text(page, ".card.risparmi .card-value"))
            emerg = euro(text(page, ".card.emergenze .card-value"))
            total = euro(text(page, ".total-account span:last-child"))
            check("E06", "saldi Risparmi ed Emergenze (input italiano '1.000') senza doppio conteggio",
                risparmi == "300,00 €" and emerg in ("1.000,00 €", "1000,00 €") and total == "10.874,10 €", f"{risparmi} | {emerg} | {total}")

            # E07 persistenza dopo ricarica: ordine, saldi, totale
            order_before = page.locator("#archive-pane-csv .csv-filename").all_text_contents()
            page.reload()
            page.wait_for_function("document.querySelectorAll('#archive-pane-csv tbody tr.asset-row[data-import-id]').length === 3")
            page.wait_for_timeout(300)
            order_after = page.locator("#archive-pane-csv .csv-filename").all_text_contents()
            total_after = euro(text(page, ".total-account span:last-child"))
            risparmi_after = euro(text(page, ".card.risparmi .card-value"))
            check("E07", "dopo la ricarica restano ordine, precedenza duplicati e saldi",
                order_after == order_before and total_after == "10.874,10 €" and risparmi_after == "300,00 €",
                f"{order_before} → {order_after}; totale {total_after}; Risparmi {risparmi_after}")

            # E07a una vecchia partizione Corrente/Risparmi sul server viene sommata una sola volta
            latest_id = page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id]").nth(2).get_attribute("data-import-id")
            page.evaluate("""async (id) => {
                const meta = await (await fetch('/api/state')).json().then(s => s.imports);
                meta.version = 1;
                meta.balances[id] = { correnti: 200, risparmi: 100, emergency: 1000 };
                await fetch('/api/state/imports', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
            }""", latest_id)
            page.reload()
            page.wait_for_function("document.querySelectorAll('#archive-pane-csv tbody tr.asset-row[data-import-id]').length === 3")
            page.wait_for_timeout(300)
            read_meta = """async (id) => {
                const meta = (await (await fetch('/api/state')).json()).imports;
                return { version: meta.version, balance: meta.balances[id] };
            }"""
            migrated = page.evaluate(read_meta, latest_id)
            page.reload()
            page.wait_for_function("document.querySelectorAll('#archive-pane-csv tbody tr.asset-row[data-import-id]').length === 3")
            page.wait_for_timeout(300)
            migrated_again = page.evaluate(read_meta, latest_id)["balance"]["risparmi"]
            check("E07a", "Corrente + Risparmi migrano una volta e Emergenze resta invariato",
                migrated["version"] == 2 and migrated["balance"].get("risparmi") == 300
                and migrated["balance"].get("correnti") is None and migrated["balance"].get("emergency") == 1000
                and migrated_again == 300, str(migrated))
            check("E07b", "il browser non salva nulla nel localStorage",
                page.evaluate("localStorage.length") == 0)

            # E08 drag-and-drop: FEB sopra GEN cambia la precedenza del duplicato
            page.click("#btn-archive")
            rows = page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id]")
            rows.nth(1).locator(".drag-handle").drag_to(rows.nth(0), target_position={"x": 20, "y": 2})
            page.wait_for_timeout(300)
            order = page.locator("#archive-pane-csv .csv-filename").all_text_contents()
            total_dnd = euro(text(page, ".total-account span:last-child"))
            page.reload()
            page.wait_for_timeout(800)
            total_reload = euro(text(page, ".total-account span:last-child"))
            check("E08", "riordino con drag-and-drop applica la nuova precedenza e persiste",
                  order[:2] == ["FEB_25.csv", "GEN_25.csv"] and total_dnd == "11.867,60 €" and total_reload == "11.867,60 €",
                  f"{order} {total_dnd} → {total_reload}")

            # E09 tipi sconosciuti (il file contiene anche una riga valida da +100 EUR): indicatori, dettagli, copia report
            page.click("#btn-archive")
            dialogs.clear()
            with page.expect_file_chooser() as chooser:
                page.click("#archive-pane-csv .btn-upload")
            chooser.value.set_files(str(FIX / "invalid" / "INV_unknown_type.csv"))
            page.wait_for_timeout(800)
            upload_message = dialogs[-1] if dialogs else ""
            check("E09c", "il conteggio upload include solo le righe valide del nuovo file",
                  "1 operazione valida" in upload_message and "3 righe non valide ignorate" in upload_message,
                  upload_message)
            if page.locator(".csv-error-row").count() == 0:
                check("E09", "riga di dettaglio errori visibile subito dopo l'upload", False, "assente fino alla ricarica")
                page.reload()
                page.wait_for_timeout(800)
                page.click("#btn-archive")
            else:
                check("E09", "riga di dettaglio errori visibile subito dopo l'upload", True)
            bang = page.locator("#archive-pane-csv .csv-filename .validation-error").count()
            header_flag = page.locator("#btn-archive.has-error").count()
            page.click(".csv-error-expand")
            details = page.locator(".csv-error-details pre").inner_text()
            page.click(".csv-error-copy")
            page.wait_for_timeout(200)
            copied = page.evaluate("navigator.clipboard.readText()")
            feedback = page.locator(".csv-error-copy").inner_text()
            check("E09a", "tipi sconosciuti: '!' su file e Archivio, dettagli espandibili",
                  bang == 1 and header_flag == 1 and "SYNTHETIC_UNKNOWN" in details, f"bang={bang} header={header_flag}")
            check("E09b", "copia report: testo negli appunti con tipo e data, senza importi; feedback 'Copiato!'",
                  "SYNTHETIC_UNKNOWN — 2 occorrenze" in copied and "-100" not in copied and "Copiato" in feedback)
            page.keyboard.press("Escape")

            # E10 l'indicatore '!' sopravvive alle modifiche dell'allocazione
            page.click("#btn-settings")
            page.click(".sidebar-nav-item[data-target='pane-allocazione']")
            first_weight = page.locator("#allocazione-tbody .asset-row .cell-percent .table-input:not(.readonly)").first
            original = first_weight.input_value()
            first_weight.fill(original)
            first_weight.dispatch_event("input")
            check("E10", "modificare l'allocazione non cancella gli indicatori d'errore dei CSV",
                  page.locator("#archive-pane-csv .csv-filename .validation-error").count() == 1)

            # E11 allocazione non valida segnalata, poi ripristinata
            core = page.locator(".section-row.core-section .section-weight-input")
            core_value = core.input_value()
            core.fill("0")
            core.dispatch_event("input")
            invalid = page.locator("#btn-settings.has-error").count() == 1
            title = page.locator("#btn-settings").get_attribute("title") or ""
            core.fill(core_value)
            core.dispatch_event("input")
            check("E11", "allocazione non valida: '!' e spiegazione; ripristino valido",
                  invalid and "Allocazione non valida" in title and page.locator("#btn-settings.has-error").count() == 0, title)

            # E23 aggiunta asset dalla riga vuota della sezione SATELLITE (target 0 per restare valida)
            empty_sat = page.locator("#allocazione-tbody tr.empty-asset-row").nth(1)
            empty_sat.locator(".cell-percent .empty-input").fill("0")
            empty_sat.locator(".empty-input.text-left").fill("Asset Manuale Sintetico")
            empty_sat.locator(".empty-input").nth(1).fill("syn0manu0001")
            empty_sat.locator(".empty-input").nth(1).press("Tab")
            page.wait_for_timeout(300)
            added = asset_row(page, "SYN0MANU0001")
            in_overview = "Asset Manuale Sintetico" in page.locator("#panel-overview .allocation-table").text_content()
            check("E23", "aggiunta asset dalla riga vuota (ISIN normalizzato) e comparsa in Overview",
                  added is not None and in_overview and page.locator("#btn-settings.has-error").count() == 0,
                  f"riga={added is not None} overview={in_overview}")

            # E24 un (A)% oltre il peso della sezione viene limitato al peso della sezione
            core_weight = page.locator(".section-row.core-section .section-weight-input").input_value()
            first_a = page.locator("#allocazione-tbody .asset-row .cell-percent .table-input:not(.readonly)").first
            previous_a = first_a.input_value()
            first_a.fill("999")
            first_a.press("Tab")
            clamped = first_a.input_value()
            first_a.fill(previous_a)
            first_a.press("Tab")
            page.wait_for_timeout(200)
            check("E24", "input (A)% limitato al peso della sezione", clamped == core_weight and
                  page.locator("#btn-settings.has-error").count() == 0, f"{clamped} vs {core_weight}")

            # E25 drag-and-drop di un asset da SATELLITE a CORE
            handle = asset_row(page, "SYN0MANU0001").locator(".drag-handle")
            # Movimenti espliciti: drag_to scorre il contenitore a trascinamento iniziato e
            # Chromium non emette dragstart (artefatto dello strumento, non dell'app).
            handle.scroll_into_view_if_needed()
            source = handle.bounding_box()
            # Bersaglio visibile: la riga vuota in fondo a CORE (inserisce l'asset alla fine di CORE).
            target = page.locator("#allocazione-tbody tr.empty-asset-row").nth(0).bounding_box()
            under = page.evaluate("([x, y]) => document.elementFromPoint(x, y)?.closest('tr')?.className",
                                  [target["x"] + 60, target["y"] + 10])
            page.mouse.move(source["x"] + 12, source["y"] + 12)
            page.mouse.down()
            page.mouse.move(source["x"] + 12, source["y"] + 2, steps=5)
            page.mouse.move(target["x"] + 60, target["y"] + 10, steps=15)
            page.mouse.up()
            page.wait_for_timeout(300)
            section_of = page.evaluate("""() => {
                let row = [...document.querySelectorAll('#allocazione-tbody tr.asset-row')]
                  .find(r => [...r.querySelectorAll('input')].some(i => i.value === 'SYN0MANU0001'));
                while (row && !row.classList.contains('section-row')) row = row.previousElementSibling;
                return row?.querySelector('.section-label')?.textContent.trim();
            }""")
            check("E25", "drag-and-drop sposta l'asset nella sezione CORE", section_of == "CORE",
                  f"sezione={section_of}, elemento sotto il cursore={under}")

            # E26 eliminazione asset dalla configurazione
            asset_row(page, "SYN0MANU0001").locator(".btn-delete").click()
            page.wait_for_timeout(300)
            check("E26", "eliminazione asset dall'allocazione e dall'Overview",
                  asset_row(page, "SYN0MANU0001") is None
                  and "Asset Manuale Sintetico" not in page.locator("#panel-overview .allocation-table").text_content())

            # E12 soglie persistite
            page.click(".sidebar-nav-item[data-target='pane-soglia']")
            page.fill("#soglia-a", "7,5")
            page.dispatch_event("#soglia-a", "input")
            page.click("#settings-modal-close")
            page.reload()
            page.wait_for_timeout(800)
            check("E12", "soglia (A) personalizzata salvata per il profilo", page.input_value("#soglia-a") == "7,5",
                  page.input_value("#soglia-a"))

            # E12b soglia negativa trattata come zero
            page.click("#btn-settings")
            page.wait_for_timeout(500)
            page.click(".sidebar-nav-item[data-target='pane-soglia']")
            page.fill("#soglia-ap", "-3")
            page.dispatch_event("#soglia-ap", "input")
            page.click("#settings-modal-close")
            page.reload()
            page.wait_for_timeout(800)
            check("E12b", "soglia negativa salvata come 0", page.input_value("#soglia-ap") == "0", page.input_value("#soglia-ap"))
            page.click("#btn-settings")
            page.wait_for_timeout(500)  # attende la fine dell'animazione di apertura del modale
            page.click(".sidebar-nav-item[data-target='pane-soglia']")
            page.fill("#soglia-ap", "3")
            page.dispatch_event("#soglia-ap", "input")
            page.click("#settings-modal-close")

            # E12c soglia relativa e importo minimo persistiti, poi riportati a 0
            page.click("#btn-settings")
            page.wait_for_timeout(500)
            page.click(".sidebar-nav-item[data-target='pane-soglia']")
            page.fill("#soglia-rel", "25")
            page.dispatch_event("#soglia-rel", "input")
            page.fill("#soglia-min", "50")
            page.dispatch_event("#soglia-min", "input")
            page.click("#settings-modal-close")
            page.reload()
            page.wait_for_timeout(800)
            saved_rel, saved_min = page.input_value("#soglia-rel"), page.input_value("#soglia-min")
            check("E12c", "soglia relativa e importo minimo salvati per il profilo",
                  saved_rel == "25" and saved_min == "50", f"{saved_rel} {saved_min}")
            page.click("#btn-settings")
            page.wait_for_timeout(500)
            page.click(".sidebar-nav-item[data-target='pane-soglia']")
            for field in ("#soglia-rel", "#soglia-min"):
                page.fill(field, "0")
                page.dispatch_event(field, "input")
            page.click("#settings-modal-close")

            # E13 rebalancing
            page.click("#tab-rebalancing")
            statuses = page.locator("#panel-rebalancing .status-badge").all_inner_texts()
            page.click("#tab-overview")
            check("E13", "tabella rebalancing popolata",
                  len(statuses) >= 6 and set(statuses) <= {"BUY", "SELL", "HOLD"}, str(statuses))

            # E14 PDF Giacenza Media
            page.click("#btn-archive")
            page.click(".sidebar-nav-item[data-target='archive-pane-giacenza']")
            names = page.locator(".pdf-name").all_inner_texts()
            with page.expect_download() as download_info:
                page.click("[data-pdf-year='2025']")
            download = download_info.value
            pdf_path = data_dir / "download.pdf"
            download.save_as(pdf_path)
            pdf = pdf_path.read_bytes()
            startxref = int(re.search(rb"startxref\n(\d+)", pdf).group(1))
            offsets = [int(x) for x in re.findall(rb"(\d{10}) 00000 n", pdf)]
            objects_ok = all(pdf[o:o + 12].startswith(f"{i + 1} 0 obj".encode()) for i, o in enumerate(offsets))
            length = int(re.search(rb"/Length (\d+)", pdf).group(1))
            stream = pdf.split(b"stream\n", 1)[1].split(b"endstream", 1)[0]
            check("E14", "PDF GM_25.pdf: nome, header, xref, lunghezza stream e EOF coerenti",
                  "GM_25.pdf" in names and download.suggested_filename == "GM_25.pdf" and pdf.startswith(b"%PDF-1.4")
                  and pdf.rstrip().endswith(b"%%EOF") and pdf[startxref:startxref + 4] == b"xref" and objects_ok
                  and length == len(stream), f"{names} {download.suggested_filename}")
            page.keyboard.press("Escape")

            # E15 profili: creazione, separazione dati, rinomina, eliminazione
            page.click("#btn-user")
            page.click("#btn-add-user")
            page.fill("#new-user-name", "Profilo E2E Due")
            page.click("#save-new-user")
            page.wait_for_timeout(800)
            empty_total = euro(text(page, ".total-account span:last-child"))
            new_threshold = page.input_value("#soglia-a")
            empty_rows = page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id]").count()
            page.click("#btn-settings")
            page.wait_for_timeout(500)
            page.click(".sidebar-nav-item[data-target='pane-utente']")
            page.fill("#user-name-input", "Profilo E2E Rinominato")
            page.click("#user-name-save")
            page.wait_for_timeout(300)
            renamed = page.locator("#current-user-name").text_content().strip()
            page.click("#settings-modal-close")
            page.click("#btn-user")
            page.click(".user-item:not(.active)")
            page.wait_for_timeout(800)
            back_total = euro(text(page, ".total-account span:last-child"))
            back_threshold = page.input_value("#soglia-a")
            page.click("#btn-user")
            deleted_id = page.locator(".user-item:not(.active)").first.get_attribute("data-user-id")
            page.click(".user-item:not(.active) .btn-user-action.delete")
            page.wait_for_timeout(500)
            users = json.loads(urllib.request.urlopen(f"{base}/api/users").read())
            leftover = [p.name for p in (data_dir / "state").glob(f"*{deleted_id}*")]
            check("E15c", "eliminando un profilo si eliminano anche le sue impostazioni sul server", leftover == [], str(leftover))
            check("E15b", "le soglie mostrate seguono il profilo selezionato",
                  new_threshold == "5" and back_threshold == "7,5", f"nuovo={new_threshold} ritorno={back_threshold}")
            check("E15", "profili: nuovo profilo vuoto, rinomina, ritorno ai dati, eliminazione",
                  empty_total == "0,00 €" and empty_rows == 0 and renamed == "Profilo E2E Rinominato"
                  and back_total == "11.967,60 €" and len(users["users"]) == 1,
                  f"{empty_total} {empty_rows} {renamed} {back_total} {len(users['users'])}")

            # E16 un CSV non valido già presente in archivio non svuota l'archivio
            bad = data_dir / "csv" / "user-1" / "2025-01-01T00-00-00_GUASTO.csv"
            shutil.copy(FIX / "invalid" / "INV_missing_header.csv", bad)
            page.reload()
            page.wait_for_timeout(800)
            rows_count = page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id]").count()
            check("E16", "un file guasto in archivio non nasconde gli altri file",
                  rows_count == 5 and euro(text(page, ".total-account span:last-child")) == "11.967,60 €",
                  f"righe={rows_count} totale={text(page, '.total-account span:last-child')}")
            bad.unlink()

            # E17 impostazioni salvate non riconoscibili: l'app resta utilizzabile
            page.evaluate("""() => fetch('/api/state/settings', { method: 'PUT',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 99 }) })""")
            dialogs.clear()
            page.reload()
            page.wait_for_timeout(800)
            usable = True
            try:
                with page.expect_file_chooser(timeout=2000):
                    page.click("#btn-archive")
                    page.click("#archive-pane-csv .btn-upload")
            except Exception:
                usable = False
            page.keyboard.press("Escape")
            check("E17", "impostazioni non leggibili: avviso e pulsanti ancora funzionanti", usable and bool(dialogs), " | ".join(dialogs))
            if not usable:  # evita che il difetto di E17 si propaghi ai controlli successivi
                page.reload()
                page.wait_for_timeout(800)

            # E18 eliminazione CSV dall'interfaccia
            page.click("#btn-archive")
            before_rows = page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id]").count()
            page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id] .btn-delete").last.click()
            page.wait_for_timeout(500)
            after_rows = page.locator("#archive-pane-csv tbody tr.asset-row[data-import-id]").count()
            check("E18", "eliminazione di un CSV dall'Archivio", after_rows == before_rows - 1, f"{before_rows}→{after_rows}")
            page.keyboard.press("Escape")

            # E19 errore di rete: server fermo durante un upload
            server.kill()
            server.wait()
            dialogs.clear()
            page.click("#btn-archive")
            with page.expect_file_chooser() as chooser:
                page.click("#archive-pane-csv .btn-upload")
            chooser.value.set_files(str(FIX / "valid" / "SYN_GEN_25.csv"))
            page.wait_for_timeout(800)
            check("E19", "errore di rete segnalato all'utente", any("Importazione CSV non riuscita" in d for d in dialogs), " | ".join(dialogs))

            check("E21", "nessun errore JavaScript non gestito", not page_errors, " | ".join(page_errors))
            check("E22", "nessuna richiesta verso host esterni durante tutta la sessione", not external, ", ".join(external))
            browser.close()
    finally:
        if server.poll() is None:
            server.kill()
        shutil.rmtree(data_dir, ignore_errors=True)

    failed = [r for r in RESULTS if not r[2]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} verifiche E2E superate")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
