/* ============================================================
   CSVXpressSmart 2026 — app.js  v2.2.0
   Fix: fmtDec unica, calcoli corretti, venduto×qta nel totale
   New: titolo preventivo, autosave WIP, riordino righe,
        conferma cancella, contatore select, esc() XSS-safe
   ============================================================ */
'use strict';

// ──────────────────────────────────────────────────────────
// SERVICE WORKER
// ──────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('service-worker.js?v=2.2.0');
      await reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller)
            nw.postMessage({ type: 'SKIP_WAITING' });
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('sw_reloaded')) return;
        sessionStorage.setItem('sw_reloaded', '1');
        location.reload();
      });
    } catch (e) { console.warn('SW:', e); }
  });
}

// ──────────────────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────────────────
let listino          = [];
let situazione       = [];
let articoliAggiunti = [];
let autoCosti        = true;

const smartSettings = {
  smartMode: false, showVAT: false, vatRate: 22,
  hideVenduto: true, hideDiff: true, hideDiscounts: true, showClientDiscount: false,
};

// ──────────────────────────────────────────────────────────
// NUMBER UTILS
// ──────────────────────────────────────────────────────────
function parseDec(val) {
  let s = String(val ?? '').trim().replace(/\s+/g, '');
  // Gestisce sia formato IT (1.234,56) sia EN (1,234.56) sia semplice (1234,56 o 1234.56)
  const hasComma = s.includes(',');
  const hasDot   = s.includes('.');
  if (hasComma && hasDot) {
    // Entrambi presenti: l'ultimo e' il decimale
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
    } else {
      s = s.replace(/,/g, '');                     // 1,234.56 -> 1234.56
    }
  } else if (hasComma) {
    s = s.replace(',', '.');                       // 1234,56 -> 1234.56
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Formatta numero → stringa italiana con virgola.
 * @param {number} n
 * @param {number} [d=2]        cifre decimali
 * @param {boolean} [trim=true] rimuove zeri finali
 */
function fmtDec(n, d, trim) {
  d    = (d    === undefined) ? 2    : d;
  trim = (trim === undefined) ? true : trim;
  if (!Number.isFinite(n)) return '';
  let s = Number(n).toFixed(d);
  if (trim) s = s.replace(/\.?0+$/, '');
  return s.replace('.', ',');
}

function roundTwo(n) { return Math.round(n * 100) / 100; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

/** €\u202fXX,XX */
function fmtEur(n) { return '\u20AC\u202f' + fmtDec(roundTwo(n), 2, false); }

function sanitizeDecInput(s) {
  s = String(s ?? '').replace(/[^\d,.\-]/g, '');
  s = s.replace(/(?!^)-/g, '');
  const i = s.search(/[.,]/);
  if (i !== -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/[.,]/g, '');
  return s;
}

function parseIntSafe(v) { const n = parseInt(v); return Number.isFinite(n) ? n : 0; }
function today() {
  return new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ──────────────────────────────────────────────────────────
// DOM HELPERS
// ──────────────────────────────────────────────────────────
function $id(id)       { return document.getElementById(id); }
function $val(id)      { return $id(id)?.value ?? ''; }
function $setVal(id,v) { const el=$id(id); if(el) el.value=v; }
function $setText(id,t){ const el=$id(id); if(el) el.textContent=t; }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ──────────────────────────────────────────────────────────
// TOAST
// ──────────────────────────────────────────────────────────
function showToast(msg, ms) {
  ms = ms || 2600;
  const t = $id('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ──────────────────────────────────────────────────────────
// INDEXEDDB
// ──────────────────────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('csvxpresssmart_2026', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res,rej)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put(val,key); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res,rej)=>{ const tx=db.transaction('kv','readonly'); const r=tx.objectStore('kv').get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
}
async function idbDel(key) {
  const db = await openDB();
  return new Promise((res,rej)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').delete(key); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
}

// ──────────────────────────────────────────────────────────
// DARK MODE
// ──────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme_2026');
  setTheme(saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches));
}
function setTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const btn = $id('btnTheme');
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
  localStorage.setItem('theme_2026', dark ? 'dark' : 'light');
}

// ──────────────────────────────────────────────────────────
// TABS
// ──────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active'); btn.setAttribute('aria-selected','true');
      const panel = $id('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

// ──────────────────────────────────────────────────────────
// SMART SETTINGS PERSISTENCE
// ──────────────────────────────────────────────────────────
function loadSettings() {
  try { const raw=localStorage.getItem('smart_settings_2026'); if(raw) Object.assign(smartSettings,JSON.parse(raw)); } catch(_){}
}
function saveSettings() {
  try { localStorage.setItem('smart_settings_2026',JSON.stringify(smartSettings)); } catch(_){}
}

// ──────────────────────────────────────────────────────────
// LISTINO CSV
// ──────────────────────────────────────────────────────────
function normalizeListino(rows) {
  return rows.map(r => ({
    codice:             String(r['Codice']            ||r['codice']            ||'').trim(),
    descrizione:        String(r['Descrizione']       ||r['descrizione']       ||'').trim(),
    prezzoLordo:        parseDec(r['PrezzoLordo']     ||r['prezzoLordo']       ||0),
    costoTrasporto:     parseDec(r['CostoTrasporto']  ||r['costoTrasporto']    ||0),
    costoInstallazione: parseDec(r['CostoInstallazione']||r['costoInstallazione']||0),
  })).filter(r => r.codice);
}

function handleCSVUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  $setText('csvFileName', file.name);
  if (typeof Papa === 'undefined') {
    showCSVError('Libreria CSV non ancora caricata. Attendi un momento e riprova (verifica la connessione internet).');
    return;
  }

  // Leggi il file come testo per rilevare il delimitatore e l'encoding
  // (su iOS Safari Papa.parse può non rilevare correttamente il sep)
  const reader = new FileReader();
  reader.onload = function(ev) {
    const text = ev.target.result;
    // Rileva separatore: conta ; e , nella prima riga
    const firstLine = text.split('\n')[0] || '';
    const nSemicolon = (firstLine.match(/;/g) || []).length;
    const nComma     = (firstLine.match(/,/g) || []).length;
    const delimiter  = nSemicolon >= nComma ? ';' : ',';

    Papa.parse(text, {
      header: true,
      delimiter: delimiter,
      skipEmptyLines: true,
      complete(res) {
        // Se con il delimitatore rilevato non ci sono colonne utili, ritenta con l'altro
        const hasColumns = res.meta && res.meta.fields &&
          res.meta.fields.some(f => /codice|Codice|CODICE|Cod/i.test(f));

        if (!hasColumns) {
          const altDelimiter = delimiter === ';' ? ',' : ';';
          Papa.parse(text, {
            header: true, delimiter: altDelimiter, skipEmptyLines: true,
            complete(res2) { processCSVResult(res2, file); },
            error()       { showCSVError('Separatore non riconosciuto'); }
          });
          return;
        }
        processCSVResult(res, file);
      },
      error() { showCSVError('Errore lettura file'); }
    });
  };
  reader.onerror = function() { showCSVError('Impossibile leggere il file'); };
  reader.readAsText(file, 'UTF-8');
}

function processCSVResult(res, file) {
  const rows = res.data || [];
  const normalized = normalizeListino(rows);

  // Reset input so iOS fires 'change' again if user picks same file
  const inp = $id('csvFileInput');
  if (inp) inp.value = '';

  if (!normalized.length) {
    const fields = (res.meta && res.meta.fields) ? res.meta.fields.join(', ') : 'nessuna';
    showCSVError('Nessun articolo trovato. Colonne: [' + fields + ']. Attese: Codice;Descrizione;PrezzoLordo;CostoTrasporto;CostoInstallazione');
    return;
  }

  listino = normalized;
  aggiornaListinoSelect();
  updateListinoStats();
  showToast('✅ Listino: ' + listino.length + ' articoli');

  const errEl = $id('csvError');
  if (errEl) errEl.style.display = 'none';

  if ($id('toggleRememberCSV')?.checked)
    idbSet('listino', { savedAt: Date.now(), name: file.name, data: listino })
      .then(updateSavedCsvInfo).catch(()=>{});
}

function showCSVError(msg) {
  showToast('❌ ' + msg, 5000);
  const errEl = $id('csvError');
  if (errEl) { errEl.textContent = '❌ ' + msg; errEl.style.display = 'block'; }
}

async function initListinoMemory() {
  await updateSavedCsvInfo();
  const p = await idbGet('listino').catch(()=>null);
  if (p?.data?.length) { listino=p.data; aggiornaListinoSelect(); updateListinoStats(); }
}

async function updateSavedCsvInfo() {
  const p = await idbGet('listino').catch(()=>null);
  const el=$id('savedCsvInfo'); if(!el) return;
  el.textContent = p?.data?.length
    ? 'Salvato: "'+p.name+'" \u2022 '+p.data.length+' articoli \u2022 '+new Date(p.savedAt).toLocaleString('it-IT')
    : 'Nessun listino salvato.';
}

function updateListinoStats() {
  const bar=$id('listinoStats'), sp=$id('statArticoli');
  if(sp) sp.textContent = listino.length + ' articoli caricati';
  if(bar) bar.style.display = listino.length ? 'block' : 'none';
}

function aggiornaListinoSelect() {
  const sel = $id('listinoSelect');
  const q   = ($val('searchListino')).toLowerCase();
  if (!sel) return;
  sel.innerHTML = '';
  const filtered = listino.filter(i => i.codice.toLowerCase().includes(q) || i.descrizione.toLowerCase().includes(q));
  filtered.forEach(item => {
    const disp = getDispNum(item.codice);
    const opt  = document.createElement('option');
    opt.value  = item.codice;
    opt.textContent = item.codice + ' \u2014 ' + item.descrizione + ' \u2014 ' + fmtEur(item.prezzoLordo)
                    + (disp !== null ? ' [Disp:' + disp + ']' : '');
    sel.appendChild(opt);
  });
  const cnt = $id('listinoCount');
  if (cnt) cnt.textContent = filtered.length
    ? filtered.length + ' di ' + listino.length + ' articoli'
    : (listino.length ? 'Nessun risultato' : 'Carica un listino CSV');
}

// ──────────────────────────────────────────────────────────
// SITUAZIONE SETTIMANALE
// ──────────────────────────────────────────────────────────
function parseSituazioneRows(raw) {
  // Trova la prima riga dati: salta tutte le righe header (codice non numerico o vuoto)
  // Il file ha tipicamente 3 righe header, ma usiamo il rilevamento automatico
  let startRow = 0;
  for (let i = 0; i < Math.min(raw.length, 6); i++) {
    const cell = String(raw[i]?.[0] ?? '').trim();
    // La prima riga con un codice articolo numerico (es. "00100208") e' la prima riga dati
    if (cell && /^\d{5,}/.test(cell)) { startRow = i; break; }
    // Oppure se contiene un codice con trattino (es. "00100302-00100321")
    if (cell && /^\d{4,}.*\d{4,}/.test(cell)) { startRow = i; break; }
  }
  return raw.slice(startRow)
    .filter(r => r[0] != null && String(r[0]).trim() !== '')
    .map(r => ({
      codice:        String(r[0]??'').trim(),
      descrizione:   String(r[1]??'').trim(),
      disponibilita: parseIntSafe(r[2]),
      arriviS15:     parseIntSafe(r[3]),
      arriviS18:     parseIntSafe(r[4]),
      arriviMaggio:  parseIntSafe(r[5]),
      arriviGiugno:  parseIntSafe(r[6]),
      note:          String(r[7]??'').trim(),
      prenotazioni:  String(r[8]??'').trim(),
      infoExtra:     String(r[9]??'').trim(),
    }))
    .filter(r => r.codice && r.codice !== 'COD. ART.');
}

function handleXLSXUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  $setText('xlsxFileName', file.name);
  const errEl = $id('xlsxError'); if(errEl) errEl.style.display='none';
  if (typeof Papa === 'undefined' || typeof XLSX === 'undefined') {
    showToast('⚠️ Librerie non ancora caricate. Attendi e riprova.', 4000);
    return;
  }

  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'csv') {
    // Leggi come testo per compatibilità iOS
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      const firstLine = text.split('\n')[0] || '';
      const delim = (firstLine.match(/;/g)||[]).length >= (firstLine.match(/,/g)||[]).length ? ';' : ',';
      Papa.parse(text, {
        header: false, delimiter: delim, skipEmptyLines: false,
        complete(res) { situazione=parseSituazioneRows(res.data); onSituazioneLoaded(file.name); },
        error()       { showToast('❌ Errore CSV situazione'); }
      });
    };
    reader.onerror = () => showToast('❌ Impossibile leggere il file');
    reader.readAsText(file, 'UTF-8');
    return;
  }

  // XLSX
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb  = XLSX.read(ev.target.result, { type: 'array' });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header:1, defval:null });
      situazione = parseSituazioneRows(raw);
      onSituazioneLoaded(file.name);
    } catch(err) {
      console.error(err); showToast('❌ Errore lettura XLSX - prova a salvarlo come CSV');
      if(errEl) { errEl.textContent='❌ Errore lettura XLSX. Prova: apri il file in Excel → Salva come → CSV UTF-8.'; errEl.style.display='block'; }
    }
  };
  reader.onerror = () => showToast('❌ Impossibile leggere il file');
  reader.readAsArrayBuffer(file);
}

function onSituazioneLoaded(fileName) {
  // Reset input per iOS (stesso file riselezionabile)
  const inp = $id('xlsxFileInput');
  if (inp) inp.value = '';

  renderDispTable();
  aggiornaListinoSelect();
  aggiornaBadgePreventivo();
  showToast('✅ Situazione: ' + situazione.length + ' articoli');
  if ($id('toggleRememberXLSX')?.checked)
    idbSet('situazione',{savedAt:Date.now(),name:fileName,data:situazione}).then(updateSavedXlsxInfo).catch(()=>{});
}

async function initXLSXMemory() {
  await updateSavedXlsxInfo();
  const p = await idbGet('situazione').catch(()=>null);
  if (p?.data?.length) { situazione=p.data; renderDispTable(); aggiornaListinoSelect(); }
}

async function updateSavedXlsxInfo() {
  const p = await idbGet('situazione').catch(()=>null);
  const el=$id('savedXlsxInfo'); if(!el) return;
  el.textContent = p?.data?.length
    ? 'Salvata: "'+p.name+'" \u2022 '+p.data.length+' righe \u2022 '+new Date(p.savedAt).toLocaleString('it-IT')
    : 'Nessuna situazione salvata.';
}

// ──────────────────────────────────────────────────────────
// DISPONIBILITÀ — lookup
// ──────────────────────────────────────────────────────────
function findDispRow(codice) {
  if (!situazione.length) return null;
  let r = situazione.find(s => s.codice === codice);
  if (r) return r;
  r = situazione.find(s => s.codice.split(/[-\s]+/).some(p => p.trim() === codice));
  if (r) return r;
  const pfx = codice.slice(0, 8);
  return situazione.find(s => s.codice.startsWith(pfx)) ?? null;
}
function getDispNum(codice) { const r=findDispRow(codice); return r ? r.disponibilita : null; }
function arriviTot(r) { return r.arriviS15+r.arriviS18+r.arriviMaggio+r.arriviGiugno; }
function arriviLabel(r) {
  const p=[];
  if(r.arriviS15)    p.push('S15:'+r.arriviS15);
  if(r.arriviS18)    p.push('S18:'+r.arriviS18);
  if(r.arriviMaggio) p.push('Mag:'+r.arriviMaggio);
  if(r.arriviGiugno) p.push('Giu:'+r.arriviGiugno);
  return p.join(' ');
}
function dispBadgeHTML(val, hasArr) {
  if (val > 5)   return '<span class="disp-badge disp-ok">'+val+'</span>';
  if (val > 0)   return '<span class="disp-badge disp-low">'+val+'</span>';
  if (hasArr)    return '<span class="disp-badge disp-arriving">0+</span>';
  return '<span class="disp-badge disp-zero">0</span>';
}

// ──────────────────────────────────────────────────────────
// TABELLA DISPONIBILITÀ
// ──────────────────────────────────────────────────────────
let _dispFilter='all', _dispSearch='';

function getFilteredSituazione() {
  return situazione.filter(r => {
    const q = _dispSearch.toLowerCase();
    if (q && !r.codice.toLowerCase().includes(q) && !r.descrizione.toLowerCase().includes(q)) return false;
    if (_dispFilter==='available') return r.disponibilita>0;
    if (_dispFilter==='zero')      return r.disponibilita===0;
    if (_dispFilter==='arriving')  return arriviTot(r)>0;
    if (_dispFilter==='noted')     return !!(r.note||r.prenotazioni);
    return true;
  });
}

function renderDispTable() {
  const wrap=$id('dispTableWrap'), filt=$id('dispFilters'), cntEl=$id('dispCount'), body=$id('dispBody');
  if(!wrap||!body) return;
  const rows=getFilteredSituazione();
  if(cntEl) cntEl.textContent = rows.length+' di '+situazione.length+' articoli';
  body.innerHTML = rows.map(r => {
    const hasArr=arriviTot(r)>0;
    return '<tr><td><strong>'+esc(r.codice)+'</strong></td><td>'+esc(r.descrizione)+'</td>'
      +'<td class="num">'+dispBadgeHTML(r.disponibilita,hasArr)+'</td>'
      +'<td class="num">'+(r.arriviS15||'\u2014')+'</td>'
      +'<td class="num">'+(r.arriviS18||'\u2014')+'</td>'
      +'<td class="num">'+(r.arriviMaggio||'\u2014')+'</td>'
      +'<td class="num">'+(r.arriviGiugno||'\u2014')+'</td>'
      +'<td class="'+(r.note?'note-text':'')+'">'+esc(r.note)+'</td>'
      +'<td class="'+(r.prenotazioni?'prenotaz-text':'')+'">'+esc(r.prenotazioni)+'</td>'
      +'<td class="muted small">'+esc(r.infoExtra)+'</td></tr>';
  }).join('');
  wrap.style.display='block'; filt.style.display='block';
}

function exportDispCSV() {
  const rows=getFilteredSituazione();
  const header='Codice;Descrizione;Disp.;S15;S18;Maggio;Giugno;Note;Prenotazioni;Info';
  const lines=[header].concat(rows.map(r=>[r.codice,r.descrizione,r.disponibilita,
    r.arriviS15||'',r.arriviS18||'',r.arriviMaggio||'',r.arriviGiugno||'',
    r.note,r.prenotazioni,r.infoExtra].join(';')));
  downloadBlob('\ufeff'+lines.join('\n'), 'situazione_'+new Date().toISOString().slice(0,10)+'.csv','text/csv;charset=utf-8');
}

// ──────────────────────────────────────────────────────────
// CALCOLI RIGA
// ──────────────────────────────────────────────────────────
function computeRow(a) {
  const prezzoLordo = parseDec(a.prezzoLordo||0);
  const qta         = Math.max(1, parseInt(a.quantita||1)||1);
  const useClient   = !!smartSettings.showClientDiscount && !a.__skipClient;

  let sc1=0, sc2=0, marg=0;
  if (useClient) {
    sc1 = clamp(parseDec(a.scontoCliente||0), 0, 100);
  } else {
    sc1  = clamp(parseDec(a.sconto ||0), 0, 100);
    sc2  = clamp(parseDec(a.sconto2||0), 0, 100);
    marg = clamp(parseDec(a.margine||0), -999, 100);
  }

  const dopoS1          = prezzoLordo * (1 - sc1/100);
  const totaleNettoUnit = roundTwo(sc2>0 ? dopoS1*(1-sc2/100) : dopoS1);
  const conMargineUnit  = roundTwo(totaleNettoUnit * (1 - marg/100));

  const trasporto     = Math.max(0, parseDec(a.costoTrasporto    ||0));
  const installazione = Math.max(0, parseDec(a.costoInstallazione||0));
  const granTotRiga   = roundTwo((conMargineUnit + trasporto + installazione) * qta);
  const venduto       = parseDec(a.venduto||0);
  const differenzaUnit = roundTwo(conMargineUnit - venduto);   // per 1 pezzo
  const differenza     = roundTwo(differenzaUnit * qta);       // per la riga (qta pezzi)

  return { prezzoLordo, qta, sconto1:sc1, sconto2:sc2, margine:marg,
           totaleNettoUnit, conMargineUnit,
           trasporto, installazione, granTotRiga, venduto, differenzaUnit, differenza };
}

// ──────────────────────────────────────────────────────────
// RENDER TABELLA PREVENTIVO
// ──────────────────────────────────────────────────────────
function renderTabellaArticoli() {
  const body=document.getElementById('articoliBody');
  const emptyEl=$id('emptyMsg');
  if (!body) return;

  if (!articoliAggiunti.length) {
    body.innerHTML='';
    if(emptyEl) emptyEl.style.display='block';
    aggiornaTotali(); return;
  }
  if(emptyEl) emptyEl.style.display='none';

  body.innerHTML = articoliAggiunti.map(buildRow).join('');

  // input live sanitize + save
  body.querySelectorAll('input[data-field]').forEach(inp => {
    inp.addEventListener('input', e => {
      const clean = sanitizeDecInput(e.target.value);
      if (e.target.value !== clean) e.target.value = clean;
    });
    inp.addEventListener('change', e => {
      const tr  = inp.closest('tr');
      const idx = parseInt(tr?.dataset.idx);
      if (!isNaN(idx) && articoliAggiunti[idx])
        articoliAggiunti[idx][inp.dataset.field] = e.target.value;
      aggiornaCalcoliRighe();
      aggiornaTotali();
      updateEquivDiscount();
      salvaPreventivo();
    });
  });

  // rimuovi
  body.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      articoliAggiunti.splice(parseInt(btn.dataset.idx),1);
      renderTabellaArticoli(); aggiornaTotali(); updateEquivDiscount(); salvaPreventivo();
    });
  });

  // riordina
  body.querySelectorAll('.btn-up,.btn-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx  = parseInt(btn.closest('tr').dataset.idx);
      const dest = btn.classList.contains('btn-up') ? idx-1 : idx+1;
      if (dest<0||dest>=articoliAggiunti.length) return;
      [articoliAggiunti[idx],articoliAggiunti[dest]]=[articoliAggiunti[dest],articoliAggiunti[idx]];
      renderTabellaArticoli();
    });
  });

  applyColumnVisibility();
}

function buildRow(a, idx) {
  const r       = computeRow(a);
  const dr      = findDispRow(a.codice);
  const dispNum = dr ? dr.disponibilita : null;
  const hasArr  = dr ? arriviTot(dr)>0 : false;
  const badge   = dispNum!==null ? dispBadgeHTML(dispNum,hasArr) : '\u2014';
  const tt      = dr
    ? 'Disp:'+dr.disponibilita+(arriviLabel(dr)?' | '+arriviLabel(dr):'')+(dr.note?' | '+dr.note:'')
    : '';

  const inp = (field, val, im) =>
    '<input type="text" data-field="'+field+'" value="'+esc(String(val))+'" inputmode="'+(im||'decimal')+'" autocomplete="off"/>';

  return '<tr data-idx="'+idx+'">'
    +'<td data-col="codice"><strong>'+esc(a.codice)+'</strong></td>'
    +'<td data-col="descrizione">'+esc(a.descrizione)+'</td>'
    +'<td data-col="dispBadge" title="'+esc(tt)+'">'+badge+'</td>'
    +'<td data-col="prezzoLordo">'+fmtEur(r.prezzoLordo)+'</td>'
    +'<td data-col="sconto1">'+inp('sconto',      fmtDec(r.sconto1,2,true))+'</td>'
    +'<td data-col="sconto2">'+inp('sconto2',     fmtDec(r.sconto2,2,true))+'</td>'
    +'<td data-col="scontoCliente">'+inp('scontoCliente',fmtDec(parseDec(a.scontoCliente||0),2,true))+'</td>'
    +'<td data-col="margine">'+inp('margine',     fmtDec(r.margine,2,true))+'</td>'
    +'<td data-col="totaleNetto">'+fmtEur(r.totaleNettoUnit)+'</td>'
    +'<td data-col="trasporto">'+inp('costoTrasporto',    fmtDec(r.trasporto,    2,true))+'</td>'
    +'<td data-col="installazione">'+inp('costoInstallazione',fmtDec(r.installazione,2,true))+'</td>'
    +'<td data-col="qta">'+inp('quantita', a.quantita||1, 'numeric')+'</td>'
    +'<td data-col="granTot">'+fmtEur(r.granTotRiga)+'</td>'
    +'<td data-col="venduto">'+inp('venduto', fmtDec(parseDec(a.venduto||0),2,true))+'</td>'
    +'<td data-col="diff" class="'+(r.differenza>=0?'tot-positive':'tot-negative')+'">'+fmtEur(r.differenza)+'</td>'
    +'<td data-col="azioni"><div class="azioni-wrap">'
    +'<button class="btn-remove" data-idx="'+idx+'" title="Rimuovi">\u2715</button>'
    +'<button class="btn-move btn-up" title="Su">\u2191</button>'
    +'<button class="btn-move btn-down" title="Gi\u00f9">\u2193</button>'
    +'</div></td></tr>';
}

function aggiornaCalcoliRighe() {
  const body=document.getElementById('articoliBody'); if(!body) return;
  body.querySelectorAll('tr[data-idx]').forEach(tr => {
    const idx=parseInt(tr.dataset.idx); const a=articoliAggiunti[idx]; if(!a) return;
    const r=computeRow(a);
    const setTd=(col,v)=>{ const td=tr.querySelector('td[data-col="'+col+'"]'); if(td) td.textContent=v; };
    setTd('totaleNetto', fmtEur(r.totaleNettoUnit));
    setTd('granTot',     fmtEur(r.granTotRiga));
    const diffTd=tr.querySelector('td[data-col="diff"]');
    if(diffTd){ diffTd.textContent=fmtEur(r.differenza); diffTd.className=r.differenza>=0?'tot-positive':'tot-negative'; }
    const dispTd=tr.querySelector('td[data-col="dispBadge"]');
    if(dispTd){ const dr2=findDispRow(a.codice); const n2=dr2?dr2.disponibilita:null; const ha=dr2?arriviTot(dr2)>0:false; dispTd.innerHTML=n2!==null?dispBadgeHTML(n2,ha):'\u2014'; }
  });
}

function aggiornaBadgePreventivo() { aggiornaCalcoliRighe(); }

// ──────────────────────────────────────────────────────────
// TOTALI
// ──────────────────────────────────────────────────────────
function aggiornaTotali() {
  const card=$id('totaliCard'), el=$id('totaleGenerale'); if(!el) return;
  if (!articoliAggiunti.length) { if(card) card.style.display='none'; return; }
  if(card) card.style.display='block';

  let tNetto=0, tCompleto=0, tVenduto=0, tDiff=0;
  articoliAggiunti.forEach(a=>{
    const r=computeRow(a);
    tNetto   += r.conMargineUnit * r.qta;
    tCompleto+= r.granTotRiga;
    tVenduto += r.venduto       * r.qta;
    tDiff    += r.differenza; // gia' moltiplicato per qta in computeRow
  });
  tNetto=roundTwo(tNetto); tCompleto=roundTwo(tCompleto); tVenduto=roundTwo(tVenduto); tDiff=roundTwo(tDiff);

  const vat=clamp(parseDec(smartSettings.vatRate??22),0,100);
  const iva=roundTwo(tCompleto*vat/100);
  const totIva=roundTwo(tCompleto+iva);

  const rows=[
    ['Totale netto (senza servizi)', fmtEur(tNetto), false],
    ['Totale (con trasp./inst.)',    fmtEur(tCompleto), true],
  ];
  if(!smartSettings.hideVenduto) rows.push(['Totale venduto',      fmtEur(tVenduto), false]);
  if(!smartSettings.hideDiff)    rows.push(['Totale diff. sconto', fmtEur(tDiff),    false]);
  if(smartSettings.showVAT) {
    rows.push(['IVA ('+vat.toFixed(1)+'%)', fmtEur(iva), false]);
    rows.push(['Totale + IVA', fmtEur(totIva), true, 'highlight']);
  }

  el.innerHTML='<table class="totali-table">'+rows.map(function(row){
    var label=row[0],val=row[1],bold=row[2],cls=row[3]||'';
    return '<tr class="'+cls+'"><td>'+(bold?'<strong>'+label+'</strong>':label)+'</td><td class="num">'+(bold?'<strong>'+val+'</strong>':val)+'</td></tr>';
  }).join('')+'</table>';
}

function updateEquivDiscount() {
  const el=$id('smartEquivalentDiscount'); if(!el) return;
  let base=0, fin=0;
  articoliAggiunti.forEach(a=>{ const r=computeRow(a); base+=parseDec(a.prezzoLordo)*r.qta; fin+=r.conMargineUnit*r.qta; });
  base=roundTwo(base); fin=roundTwo(fin);
  el.textContent = base ? clamp((1-fin/base)*100,-9999,9999).toFixed(2)+'%' : '\u2014';
}

// ──────────────────────────────────────────────────────────
// COLUMN VISIBILITY
// ──────────────────────────────────────────────────────────
function applyColumnVisibility() {
  const hide=(col,h)=>document.querySelectorAll('[data-col="'+col+'"]').forEach(el=>el.classList.toggle('col-hidden',!!h));
  const client=!!smartSettings.showClientDiscount, smart=!!smartSettings.smartMode;
  hide('sconto1',        client);
  hide('sconto2',        client);
  hide('scontoCliente', !client);
  hide('margine',        smart||client);
  hide('prezzoLordo',    smart);
  hide('venduto',        smart||smartSettings.hideVenduto);
  hide('diff',           smart||smartSettings.hideDiff);
}

// ──────────────────────────────────────────────────────────
// AGGIUNGI ARTICOLI
// ──────────────────────────────────────────────────────────
function newArticoloFrom(base) {
  return { codice:base.codice, descrizione:base.descrizione, prezzoLordo:base.prezzoLordo,
           sconto:0, sconto2:0, margine:0, scontoCliente:0,
           costoTrasporto:    autoCosti ? base.costoTrasporto     : 0,
           costoInstallazione:autoCosti ? base.costoInstallazione : 0,
           quantita:1, venduto:0 };
}

function aggiungiDaListino() {
  const sel=$id('listinoSelect'); if(!sel?.value){ showToast('⚠️ Nessun articolo'); return; }
  const item=listino.find(i=>i.codice===sel.value); if(!item) return;
  const dr=findDispRow(item.codice);
  if(dr){
    const arr=arriviLabel(dr), hint=$id('dispHint');
    if(hint){
      hint.innerHTML='<span class="disp-hint">📦 '+esc(item.codice)+' \u2014 Disp: '+dr.disponibilita+(arr?' | '+arr:'')+(dr.note?' | '+esc(dr.note):'')+' </span>';
      hint.style.display='block';
    }
  }
  articoliAggiunti.push(newArticoloFrom(item));
  renderTabellaArticoli(); aggiornaTotali(); updateEquivDiscount(); salvaPreventivo();
  showToast('✅ Aggiunto: '+item.descrizione);
}

function aggiungiManuale() {
  const codice=$val('manCodice').trim(), descrizione=$val('manDescrizione').trim();
  if(!codice||!descrizione){ showToast('⚠️ Codice e descrizione obbligatori'); return; }
  articoliAggiunti.push({codice,descrizione,prezzoLordo:parseDec($val('manPrezzo')),
    costoTrasporto:parseDec($val('manTrasporto')),costoInstallazione:parseDec($val('manInstallazione')),
    sconto:0,sconto2:0,margine:0,scontoCliente:0,quantita:1,venduto:0});
  ['manCodice','manDescrizione','manPrezzo','manTrasporto','manInstallazione'].forEach(id=>$setVal(id,''));
  renderTabellaArticoli(); aggiornaTotali(); updateEquivDiscount(); salvaPreventivo();
  showToast('✅ Aggiunto manualmente: '+codice);
}

// ──────────────────────────────────────────────────────────
// SCONTO CLIENTE MODE
// ──────────────────────────────────────────────────────────
function computeEquivClientDiscount(a) {
  const pL=parseDec(a.prezzoLordo||0); if(pL<=0) return 0;
  const r=computeRow({...a,__skipClient:true});
  return clamp((1-r.conMargineUnit/pL)*100,0,100);
}

function applyClientDiscountMode(enabled) {
  articoliAggiunti=articoliAggiunti.map(a=>{
    const item={...a};
    if(enabled){
      item._bakSconto  = item._bakSconto  ?? parseDec(item.sconto ||0);
      item._bakSconto2 = item._bakSconto2 ?? parseDec(item.sconto2||0);
      item._bakMargine = item._bakMargine ?? parseDec(item.margine||0);
      item.scontoCliente=computeEquivClientDiscount(item);
      item.sconto=0; item.sconto2=0; item.margine=0;
    } else {
      if(item._bakSconto  !==undefined) item.sconto =item._bakSconto;
      if(item._bakSconto2 !==undefined) item.sconto2=item._bakSconto2;
      if(item._bakMargine !==undefined) item.margine=item._bakMargine;
    }
    return item;
  });
  renderTabellaArticoli(); aggiornaTotali(); updateEquivDiscount();
}

// ──────────────────────────────────────────────────────────
// AUTOSAVE PREVENTIVO IN CORSO
// ──────────────────────────────────────────────────────────
async function salvaPreventivo() {
  try { await idbSet('preventivo_wip',{savedAt:Date.now(),titolo:$val('preventivoTitolo')||'',articoli:articoliAggiunti}); } catch(_){}
}

async function ripristinaPreventivo() {
  try {
    const p=await idbGet('preventivo_wip');
    if(!p?.articoli?.length) return;
    articoliAggiunti=p.articoli;
    if(p.titolo) $setVal('preventivoTitolo',p.titolo);
    renderTabellaArticoli(); aggiornaTotali(); updateEquivDiscount();
    showToast('🔄 Preventivo precedente ripristinato ('+articoliAggiunti.length+' articoli)',3500);
  } catch(_){}
}

// ──────────────────────────────────────────────────────────
// REPORT
// ──────────────────────────────────────────────────────────
function generaReport(opts) {
  opts = opts || {};
  const noMargine = !!opts.noMargine;
  const client    = !!smartSettings.showClientDiscount;
  const titolo    = $val('preventivoTitolo') || 'PREVENTIVO';
  const lines     = [titolo.toUpperCase()+' \u2014 '+today(), '\u2550'.repeat(44), ''];
  let tNetto=0, tCompleto=0;

  articoliAggiunti.forEach((a,i)=>{
    const r  = computeRow(a);
    const pD = noMargine ? r.totaleNettoUnit : r.conMargineUnit;
    lines.push((i+1)+'. '+a.codice+' \u2014 '+a.descrizione);
    if(!smartSettings.hideDiscounts&&!noMargine){
      if(client){ lines.push('   Sc.cliente: '+clamp(parseDec(a.scontoCliente||0),0,100).toFixed(2)+'%'); }
      else{
        if(r.sconto1) lines.push('   Sc.1: '+fmtDec(r.sconto1,2,true)+'%');
        if(r.sconto2) lines.push('   Sc.2: '+fmtDec(r.sconto2,2,true)+'%');
        if(r.margine) lines.push('   Marg.: '+fmtDec(r.margine,2,true)+'%');
      }
    }
    lines.push('   Prezzo netto: '+fmtEur(pD));
    lines.push('   Qt\u00e0: '+r.qta);
    if(r.trasporto)     lines.push('   Trasporto: '+fmtEur(r.trasporto));
    if(r.installazione) lines.push('   Installazione: '+fmtEur(r.installazione));
    const totRiga=roundTwo((pD+r.trasporto+r.installazione)*r.qta);
    lines.push('   Totale riga: '+fmtEur(totRiga));
    if(!smartSettings.hideVenduto&&!noMargine) lines.push('   Venduto a: '+fmtEur(r.venduto));
    if(!smartSettings.hideDiff&&!noMargine)    lines.push('   Diff.: '+fmtEur(r.differenza));
    lines.push('');
    tNetto   += pD * r.qta;
    tCompleto+= totRiga; // usa pD coerente con noMargine, non granTotRiga
  });

  lines.push('\u2500'.repeat(44));
  lines.push('Totale netto:       '+fmtEur(roundTwo(tNetto)));
  lines.push('Totale complessivo: '+fmtEur(roundTwo(tCompleto)));
  if(smartSettings.showVAT){
    const vat=clamp(parseDec(smartSettings.vatRate??22),0,100);
    const iva=roundTwo(tCompleto*vat/100);
    lines.push('IVA ('+vat.toFixed(1)+'%):        '+fmtEur(iva));
    lines.push('TOTALE + IVA:       '+fmtEur(roundTwo(tCompleto+iva)));
  }
  return lines.join('\n');
}

function mostraPreview(content) {
  const el=$id('reportPreview'); if(!el) return;
  el.textContent=content; el.style.display='block';
  el.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function downloadBlob(content,filename,type) {
  type=type||'text/plain;charset=utf-8';
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  // iOS Safari non supporta <a download> programmatico: apre in nuova scheda
  const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;
  if (isIOS) {
    // Su iOS apriamo in nuova scheda con un avviso - e' il massimo possibile senza server
    const w=window.open(url,'_blank');
    if(!w) showToast('⚠️ Popup bloccato. Abilita i popup per scaricare il file.',4000);
    else   showToast('📄 File aperto: tocca ‹ Condividi › ‹ Salva in File › per salvarlo.',5000);
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    return;
  }
  const a=document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),15000);
}

// ──────────────────────────────────────────────────────────
// SMART CONTROLS BINDING
// ──────────────────────────────────────────────────────────
// confirm() sicuro anche su iOS PWA standalone
function safeConfirm(msg) {
  try { return window.confirm(msg); } catch(_) { return true; } // se disabilitato, procedi
}

function bindSmartControls() {
  const map={
    toggleSmartMode:'smartMode', toggleShowVAT:'showVAT',
    toggleHideVenduto:'hideVenduto', toggleHideDiff:'hideDiff',
    toggleHideDiscounts:'hideDiscounts', toggleShowClientDiscount:'showClientDiscount',
  };
  // init
  Object.entries(map).forEach(([id,key])=>{ const el=$id(id); if(el) el.checked=!!smartSettings[key]; });
  $setVal('vatRate', String(smartSettings.vatRate));
  const elAC=$id('toggleAutoCosti'); if(elAC) elAC.checked=autoCosti;

  const onChange=()=>{
    const prevClient=!!smartSettings.showClientDiscount;
    Object.entries(map).forEach(([id,key])=>{ const el=$id(id); if(el) smartSettings[key]=el.checked; });
    smartSettings.vatRate=clamp(parseDec($val('vatRate')||'22'),0,100);
    autoCosti=!!$id('toggleAutoCosti')?.checked;
    if(smartSettings.smartMode) smartSettings.hideVenduto=smartSettings.hideDiff=smartSettings.hideDiscounts=true;
    saveSettings();
    if(prevClient!==smartSettings.showClientDiscount){ applyClientDiscountMode(smartSettings.showClientDiscount); return; }
    applyColumnVisibility(); aggiornaCalcoliRighe(); aggiornaTotali(); updateEquivDiscount();
  };

  [...Object.keys(map),'vatRate','toggleAutoCosti'].forEach(id=>{
    $id(id)?.addEventListener('change', onChange);
  });
}

// ──────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme(); loadSettings(); initTabs();

  $id('btnTheme')?.addEventListener('click',()=>setTheme(document.documentElement.getAttribute('data-theme')!=='dark'));

  // Listino
  $id('csvFileInput')?.addEventListener('change', handleCSVUpload);
  $id('searchListino')?.addEventListener('input',  aggiornaListinoSelect);
  $id('btnLoadSavedCSV')?.addEventListener('click', async ()=>{
    const p=await idbGet('listino').catch(()=>null);
    if(!p?.data?.length){ showToast('⚠️ Nessun listino salvato'); return; }
    listino=p.data; aggiornaListinoSelect(); updateListinoStats();
    showToast('✅ Listino: '+listino.length+' articoli');
  });
  $id('btnClearSavedCSV')?.addEventListener('click', async ()=>{
    if(!safeConfirm('Cancellare il listino salvato?')) return;
    await idbDel('listino').catch(()=>{}); listino=[];
    aggiornaListinoSelect(); updateListinoStats(); await updateSavedCsvInfo();
    showToast('🗑️ Listino cancellato');
  });

  // Disponibilità
  $id('xlsxFileInput')?.addEventListener('change', handleXLSXUpload);
  $id('btnLoadSavedXLSX')?.addEventListener('click', async ()=>{
    const p=await idbGet('situazione').catch(()=>null);
    if(!p?.data?.length){ showToast('⚠️ Nessuna situazione salvata'); return; }
    situazione=p.data; renderDispTable(); aggiornaListinoSelect();
    showToast('✅ Situazione: '+situazione.length+' righe');
  });
  $id('btnClearSavedXLSX')?.addEventListener('click', async ()=>{
    if(!safeConfirm('Cancellare la situazione salvata?')) return;
    await idbDel('situazione').catch(()=>{}); situazione=[];
    const w=$id('dispTableWrap'),f=$id('dispFilters');
    if(w) w.style.display='none'; if(f) f.style.display='none';
    await updateSavedXlsxInfo(); showToast('🗑️ Situazione cancellata');
  });
  $id('searchDisp')?.addEventListener('input',  e=>{ _dispSearch=e.target.value; renderDispTable(); });
  $id('filterDisp')?.addEventListener('change', e=>{ _dispFilter=e.target.value; renderDispTable(); });
  $id('btnExportDisp')?.addEventListener('click', exportDispCSV);

  // Preventivo
  $id('btnAddFromListino')?.addEventListener('click', aggiungiDaListino);
  $id('btnAddManual')?.addEventListener('click',  aggiungiManuale);
  $id('preventivoTitolo')?.addEventListener('input', salvaPreventivo);

  const doExport=(opts,wa)=>()=>{
    if(!articoliAggiunti.length){ showToast('⚠️ Nessun articolo'); return; }
    const r=generaReport(opts); mostraPreview(r);
    if(wa) window.open('https://api.whatsapp.com/send?text='+encodeURIComponent(r),'_blank');
    else { downloadBlob(r,'preventivo'+(opts&&opts.noMargine?'_nomarg':'')+'_'+new Date().toISOString().slice(0,10)+'.txt'); showToast('📄 TXT scaricato'); }
  };
  $id('btnWA')?.addEventListener('click',       doExport({},true));
  $id('btnTXT')?.addEventListener('click',      doExport({},false));
  $id('btnWANoMarg')?.addEventListener('click', doExport({noMargine:true},true));
  $id('btnTXTNoMarg')?.addEventListener('click',doExport({noMargine:true},false));
  $id('btnCopyClip')?.addEventListener('click', async ()=>{
    if(!articoliAggiunti.length){ showToast('⚠️ Nessun articolo'); return; }
    const r=generaReport(); mostraPreview(r);
    try{ await navigator.clipboard.writeText(r); showToast('📋 Copiato!'); }
    catch(_){ showToast('⚠️ Copia non supportata'); }
  });
  $id('btnClearAll')?.addEventListener('click',()=>{
    if(!articoliAggiunti.length) return;
    if(!safeConfirm('Svuotare la lista articoli?')) return;
    articoliAggiunti=[]; renderTabellaArticoli(); aggiornaTotali(); updateEquivDiscount(); salvaPreventivo();
    const prev=$id('reportPreview'); if(prev) prev.style.display='none';
    showToast('🗑️ Lista svuotata');
  });

  bindSmartControls();
  renderTabellaArticoli();
  aggiornaTotali();
  applyColumnVisibility();
  updateEquivDiscount();

  // dati persistiti
  await initListinoMemory();
  await initXLSXMemory();
  await ripristinaPreventivo();
});
