/* ============================================================
   CSVXpressSmart 2026 — app.js
   Versione 2.0.0
   Features:
   - Listino da CSV (codice, descrizione, prezzo, trasporto, inst.)
   - Situazione settimanale da XLSX o CSV (disponibilità, arrivi, note)
   - Preventivo con tutte le modalità (smart, sconto cliente, IVA)
   - Badge disponibilità integrato nel preventivo
   - Dark mode
   - Toast notifications
   - IndexedDB per memoria CSV e XLSX
   ============================================================ */

'use strict';

// ───────────────────────────────────────────────
// SERVICE WORKER
// ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('service-worker.js?v=2.0.0');
      await reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('sw_reloaded')) return;
        sessionStorage.setItem('sw_reloaded', '1');
        location.reload();
      });
    } catch (e) { console.warn('SW not registered', e); }
  });
}

// ───────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────
let listino = [];           // array di {codice, descrizione, prezzoLordo, costoTrasporto, costoInstallazione}
let situazione = [];        // array di righe XLSX settimanale
let articoliAggiunti = [];  // righe del preventivo
let autoCosti = true;

const smartSettings = {
  smartMode: false,
  showVAT: false,
  vatRate: 22,
  hideVenduto: true,
  hideDiff: true,
  hideDiscounts: true,
  showClientDiscount: false,
};

// ───────────────────────────────────────────────
// UTILS
// ───────────────────────────────────────────────
function parseDec(val) {
  const s = String(val ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtDec(n, d = 2) {
  if (!Number.isFinite(n)) return '';
  return n.toFixed(d).replace('.', ',');
}

function roundTwo(n) { return Math.round(n * 100) / 100; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function fmt€(n) { return '€\u202f' + fmtDec(roundTwo(n)); }

function sanitizeInput(s) {
  s = String(s ?? '').replace(/[^\d,.\-]/g, '');
  s = s.replace(/(?!^)-/g, '');
  const i = s.search(/[.,]/);
  if (i !== -1) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/[.,]/g, '');
  return s;
}

function showToast(msg, duration = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), duration);
}

// ───────────────────────────────────────────────
// INDEXEDDB HELPERS
// ───────────────────────────────────────────────
const DB_NAME = 'csvxpresssmart_2026';
const DB_VER = 1;
const STORE = 'kv';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

// ───────────────────────────────────────────────
// DARK MODE
// ───────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme_2026');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = saved === 'dark' || (!saved && prefersDark);
  setTheme(dark);
}

function setTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const btn = document.getElementById('btnTheme');
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
  localStorage.setItem('theme_2026', dark ? 'dark' : 'light');
}

// ───────────────────────────────────────────────
// TABS
// ───────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

// ───────────────────────────────────────────────
// SMART SETTINGS PERSISTENCE
// ───────────────────────────────────────────────
const SETTINGS_KEY = 'smart_settings_2026';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(smartSettings, JSON.parse(raw));
  } catch (_) {}
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(smartSettings)); } catch (_) {}
}

// ───────────────────────────────────────────────
// LISTINO CSV
// ───────────────────────────────────────────────
function normalizeListino(rows) {
  return rows
    .map(r => ({
      codice: String(r['Codice'] || r['codice'] || '').trim(),
      descrizione: String(r['Descrizione'] || r['descrizione'] || '').trim(),
      prezzoLordo: parseDec(r['PrezzoLordo'] || r['prezzoLordo'] || 0),
      costoTrasporto: parseDec(r['CostoTrasporto'] || r['costoTrasporto'] || 0),
      costoInstallazione: parseDec(r['CostoInstallazione'] || r['costoInstallazione'] || 0),
    }))
    .filter(r => r.codice);
}

function handleCSVUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('csvFileName').textContent = file.name;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    delimiter: '',   // auto-detect ; or ,
    complete(results) {
      if (!results.data.length) { showToast('⚠️ CSV vuoto o non riconosciuto'); return; }
      listino = normalizeListino(results.data);
      aggiornaListinoSelect();
      updateListinoStats();
      showToast(`✅ Listino caricato: ${listino.length} articoli`);

      if (document.getElementById('toggleRememberCSV')?.checked) {
        idbSet('listino', { savedAt: Date.now(), name: file.name, data: listino })
          .then(() => updateSavedCsvInfo())
          .catch(() => {});
      }
    },
    error() { showToast('❌ Errore parsing CSV'); }
  });
}

async function initListinoMemory() {
  await updateSavedCsvInfo();
  const payload = await idbGet('listino').catch(() => null);
  if (payload?.data?.length) {
    listino = payload.data;
    aggiornaListinoSelect();
    updateListinoStats();
  }
}

async function updateSavedCsvInfo() {
  const p = await idbGet('listino').catch(() => null);
  const el = document.getElementById('savedCsvInfo');
  if (!el) return;
  if (p?.data?.length) {
    const d = new Date(p.savedAt).toLocaleString('it-IT');
    el.textContent = `Salvato: "${p.name}" • ${p.data.length} articoli • ${d}`;
  } else {
    el.textContent = 'Nessun listino salvato.';
  }
}

function updateListinoStats() {
  const bar = document.getElementById('listinoStats');
  const span = document.getElementById('statArticoli');
  if (!bar || !span) return;
  span.textContent = `${listino.length} articoli caricati`;
  bar.style.display = listino.length ? 'block' : 'none';
}

function aggiornaListinoSelect() {
  const sel = document.getElementById('listinoSelect');
  const q = document.getElementById('searchListino')?.value?.toLowerCase() ?? '';
  if (!sel) return;
  sel.innerHTML = '';

  const filtered = listino.filter(i =>
    i.codice.toLowerCase().includes(q) || i.descrizione.toLowerCase().includes(q)
  );

  filtered.forEach(item => {
    const disp = getDispForCodice(item.codice);
    const dispTxt = disp !== null ? ` [Disp:${disp}]` : '';
    const opt = document.createElement('option');
    opt.value = item.codice;
    opt.textContent = `${item.codice} — ${item.descrizione} — ${fmt€(item.prezzoLordo)}${dispTxt}`;
    sel.appendChild(opt);
  });
}

// ───────────────────────────────────────────────
// SITUAZIONE SETTIMANALE (XLSX / CSV)
// ───────────────────────────────────────────────

/*
  Struttura attesa (come dal file allegato):
  Row 0: titolo  "SITUAZIONE SETTIMANALE AL DD-MM-YY"
  Row 1: COD. ART. | DESCRIZIONE | DISP. | ARRIVI (merge) | ... | NOTE | ...
  Row 2: (sotto ARRIVI): SETT.15 | SETT.18 | MAGGIO | GIUGNO
  Row 3+: dati

  Colonne (0-indexed):
    0 = codice
    1 = descrizione
    2 = disponibilità
    3 = arrivi sett.15
    4 = arrivi sett.18
    5 = arrivi maggio
    6 = arrivi giugno
    7 = note (AD ESAURIMENTO, colore, ecc.)
    8 = prenotazioni (2 LUCA, 11 GRAZIA ecc.)
    9 = altre info
*/

function parseSituazioneRows(rawRows) {
  // rawRows è array di array (raw from XLSX or Papa)
  // Skip intestazioni (righe 0-2 sono header)
  const dataRows = rawRows.slice(3);

  return dataRows
    .filter(r => r[0] != null && String(r[0]).trim() !== '')
    .map(r => ({
      codice: String(r[0] ?? '').trim(),
      descrizione: String(r[1] ?? '').trim(),
      disponibilita: parseInt(r[2]) || 0,
      arriviS15: parseInt(r[3]) || 0,
      arriviS18: parseInt(r[4]) || 0,
      arriviMaggio: parseInt(r[5]) || 0,
      arriviGiugno: parseInt(r[6]) || 0,
      note: String(r[7] ?? '').trim(),
      prenotazioni: String(r[8] ?? '').trim(),
      infoExtra: String(r[9] ?? '').trim(),
    }))
    .filter(r => r.codice && r.codice !== 'COD. ART.');
}

function handleXLSXUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('xlsxFileName').textContent = file.name;

  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'csv') {
    // CSV fallback
    Papa.parse(file, {
      header: false,
      skipEmptyLines: false,
      complete(res) {
        situazione = parseSituazioneRows(res.data);
        onSituazioneLoaded(file.name);
      },
      error() { showToast('❌ Errore lettura CSV situazione'); }
    });
    return;
  }

  // XLSX
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb = XLSX.read(ev.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      situazione = parseSituazioneRows(raw);
      onSituazioneLoaded(file.name);
    } catch (err) {
      console.error(err);
      showToast('❌ Errore lettura XLSX');
      document.getElementById('xlsxError').style.display = 'block';
    }
  };
  reader.readAsArrayBuffer(file);
}

function onSituazioneLoaded(fileName) {
  document.getElementById('xlsxError').style.display = 'none';
  renderDispTable();
  aggiornaListinoSelect(); // refresh con badge disp
  showToast(`✅ Situazione caricata: ${situazione.length} articoli`);

  if (document.getElementById('toggleRememberXLSX')?.checked) {
    idbSet('situazione', { savedAt: Date.now(), name: fileName, data: situazione })
      .then(() => updateSavedXlsxInfo())
      .catch(() => {});
  }
}

async function initXLSXMemory() {
  await updateSavedXlsxInfo();
  const p = await idbGet('situazione').catch(() => null);
  if (p?.data?.length) {
    situazione = p.data;
    renderDispTable();
    aggiornaListinoSelect();
  }
}

async function updateSavedXlsxInfo() {
  const p = await idbGet('situazione').catch(() => null);
  const el = document.getElementById('savedXlsxInfo');
  if (!el) return;
  if (p?.data?.length) {
    const d = new Date(p.savedAt).toLocaleString('it-IT');
    el.textContent = `Salvata: "${p.name}" • ${p.data.length} righe • ${d}`;
  } else {
    el.textContent = 'Nessuna situazione salvata.';
  }
}

// ───────────────────────────────────────────────
// TABELLA DISPONIBILITÀ
// ───────────────────────────────────────────────
let _dispFilter = 'all';
let _dispSearch = '';

function getFilteredSituazione() {
  return situazione.filter(r => {
    const q = _dispSearch.toLowerCase();
    const matchSearch = !q || r.codice.toLowerCase().includes(q) || r.descrizione.toLowerCase().includes(q);
    if (!matchSearch) return false;

    switch (_dispFilter) {
      case 'available': return r.disponibilita > 0;
      case 'zero': return r.disponibilita === 0;
      case 'arriving': return (r.arriviS15 + r.arriviS18 + r.arriviMaggio + r.arriviGiugno) > 0;
      case 'noted': return !!r.note || !!r.prenotazioni;
      default: return true;
    }
  });
}

function dispBadgeHTML(val, hasArriving) {
  if (val > 5) return `<span class="disp-badge disp-ok">${val}</span>`;
  if (val > 0) return `<span class="disp-badge disp-low">${val}</span>`;
  if (hasArriving) return `<span class="disp-badge disp-arriving">0+</span>`;
  return `<span class="disp-badge disp-zero">0</span>`;
}

function arriviText(r) {
  const parts = [];
  if (r.arriviS15) parts.push(`S15:${r.arriviS15}`);
  if (r.arriviS18) parts.push(`S18:${r.arriviS18}`);
  if (r.arriviMaggio) parts.push(`Mag:${r.arriviMaggio}`);
  if (r.arriviGiugno) parts.push(`Giu:${r.arriviGiugno}`);
  return parts.join(' ');
}

function renderDispTable() {
  const wrap = document.getElementById('dispTableWrap');
  const filters = document.getElementById('dispFilters');
  const countEl = document.getElementById('dispCount');
  const body = document.getElementById('dispBody');
  if (!wrap || !body) return;

  const rows = getFilteredSituazione();
  countEl.textContent = `${rows.length} di ${situazione.length} articoli`;

  body.innerHTML = rows.map(r => {
    const hasArr = (r.arriviS15 + r.arriviS18 + r.arriviMaggio + r.arriviGiugno) > 0;
    const noteCls = r.note ? 'note-text' : '';
    const prenotazCls = r.prenotazioni ? 'prenotaz-text' : '';

    return `<tr>
      <td><strong>${r.codice}</strong></td>
      <td>${r.descrizione}</td>
      <td class="num">${dispBadgeHTML(r.disponibilita, hasArr)}</td>
      <td class="num">${r.arriviS15 || '—'}</td>
      <td class="num">${r.arriviS18 || '—'}</td>
      <td class="num">${r.arriviMaggio || '—'}</td>
      <td class="num">${r.arriviGiugno || '—'}</td>
      <td class="${noteCls}">${r.note || ''}</td>
      <td class="${prenotazCls}">${r.prenotazioni || ''}</td>
      <td class="muted small">${r.infoExtra || ''}</td>
    </tr>`;
  }).join('');

  wrap.style.display = 'block';
  filters.style.display = 'block';
}

function exportDispCSV() {
  const rows = getFilteredSituazione();
  const header = ['Codice','Descrizione','Disp.','S15','S18','Maggio','Giugno','Note','Prenotazioni','Info'];
  const lines = [header.join(';')];
  rows.forEach(r => {
    lines.push([r.codice, r.descrizione, r.disponibilita,
      r.arriviS15 || '', r.arriviS18 || '', r.arriviMaggio || '', r.arriviGiugno || '',
      r.note, r.prenotazioni, r.infoExtra].join(';'));
  });
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `situazione_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ───────────────────────────────────────────────
// DISPONIBILITÀ HELPER (per preventivo)
// ───────────────────────────────────────────────
function getDispForCodice(codice) {
  if (!situazione.length) return null;
  // cerca codice esatto o se il codice del situazione contiene il codice listino
  const r = situazione.find(s =>
    s.codice === codice ||
    s.codice.includes(codice) ||
    codice.includes(s.codice.split('-')[0].trim())
  );
  return r ? r.disponibilita : null;
}

function getDispRowForCodice(codice) {
  if (!situazione.length) return null;
  return situazione.find(s =>
    s.codice === codice ||
    s.codice.includes(codice) ||
    codice.includes(s.codice.split('-')[0].trim())
  ) || null;
}

// ───────────────────────────────────────────────
// PREVENTIVO — CALCOLI RIGA
// ───────────────────────────────────────────────
function computeRow(a) {
  const prezzoLordo = parseDec(a.prezzoLordo || 0);
  const qta = Math.max(1, parseInt(a.quantita || 1) || 1);
  const useClient = !!smartSettings.showClientDiscount && !a.__skipClient;

  let sconto1 = 0, sconto2 = 0, margine = 0;

  if (useClient) {
    const sc = clamp(parseDec(a.scontoCliente || 0), 0, 100);
    sconto1 = sc; sconto2 = 0; margine = 0;
  } else {
    sconto1 = clamp(parseDec(a.sconto || 0), 0, 100);
    sconto2 = clamp(parseDec(a.sconto2 || 0), 0, 100);
    margine = clamp(parseDec(a.margine || 0), -999, 100);
  }

  const dopoS1 = prezzoLordo * (1 - sconto1 / 100);
  const dopoS2 = dopoS1 * (1 - sconto2 / 100);
  const totaleNettoUnit = roundTwo(dopoS2);
  const conMargineUnit = roundTwo(dopoS2 * (1 - margine / 100));

  const trasporto = Math.max(0, parseDec(a.costoTrasporto || 0));
  const installazione = Math.max(0, parseDec(a.costoInstallazione || 0));

  const granTotRiga = roundTwo((conMargineUnit + trasporto + installazione) * qta);
  const venduto = parseDec(a.venduto || 0);
  const differenza = roundTwo(conMargineUnit - venduto);

  return { prezzoLordo, qta, sconto1, sconto2, margine, totaleNettoUnit,
           conMargineUnit, trasporto, installazione, granTotRiga, venduto, differenza };
}

// ───────────────────────────────────────────────
// PREVENTIVO — RENDER
// ───────────────────────────────────────────────
function renderTabellaArticoli() {
  const body = document.getElementById('articoliBody');
  const emptyMsg = document.getElementById('emptyMsg');
  if (!body) return;

  if (!articoliAggiunti.length) {
    body.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  body.innerHTML = articoliAggiunti.map((a, idx) => {
    const r = computeRow(a);
    const disp = getDispForCodice(a.codice);
    const dispRow = getDispRowForCodice(a.codice);

    let dispBadge = '—';
    if (disp !== null) {
      dispBadge = dispBadgeHTML(disp, dispRow && (dispRow.arriviS15 + dispRow.arriviS18 + dispRow.arriviMaggio + dispRow.arriviGiugno) > 0);
    }

    const dispTitle = dispRow
      ? `title="Disp:${dispRow.disponibilita} | ${arriviText(dispRow)} | ${dispRow.note}"`
      : '';

    return `<tr data-idx="${idx}">
      <td data-col="codice">${a.codice}</td>
      <td data-col="descrizione">${a.descrizione}</td>
      <td data-col="dispBadge" ${dispTitle}>${dispBadge}</td>
      <td data-col="prezzoLordo">${fmt€(r.prezzoLordo)}</td>
      <td data-col="sconto1"><input type="text" data-field="sconto" value="${fmtDec(r.sconto1, 2, true)}" inputmode="decimal"/></td>
      <td data-col="sconto2"><input type="text" data-field="sconto2" value="${fmtDec(r.sconto2, 2, true)}" inputmode="decimal"/></td>
      <td data-col="scontoCliente"><input type="text" data-field="scontoCliente" value="${fmtDec(parseDec(a.scontoCliente || 0), 2, true)}" inputmode="decimal"/></td>
      <td data-col="margine"><input type="text" data-field="margine" value="${fmtDec(r.margine, 2, true)}" inputmode="decimal"/></td>
      <td data-col="totaleNetto">${fmt€(r.totaleNettoUnit)}</td>
      <td data-col="trasporto"><input type="text" data-field="costoTrasporto" value="${fmtDec(r.trasporto, 2, true)}" inputmode="decimal"/></td>
      <td data-col="installazione"><input type="text" data-field="costoInstallazione" value="${fmtDec(r.installazione, 2, true)}" inputmode="decimal"/></td>
      <td data-col="qta"><input type="text" data-field="quantita" value="${a.quantita || 1}" inputmode="numeric"/></td>
      <td data-col="granTot">${fmt€(r.granTotRiga)}</td>
      <td data-col="venduto"><input type="text" data-field="venduto" value="${fmtDec(parseDec(a.venduto || 0), 2, true)}" inputmode="decimal"/></td>
      <td data-col="diff" class="${r.differenza >= 0 ? 'tot-positive' : 'tot-negative'}">${fmt€(r.differenza)}</td>
      <td data-col="azioni"><button class="btn-remove" data-idx="${idx}">✕</button></td>
    </tr>`;
  }).join('');

  // Bind input events
  body.querySelectorAll('input[data-field]').forEach(inp => {
    inp.addEventListener('input', e => {
      const val = sanitizeInput(e.target.value);
      if (e.target.value !== val) { e.target.value = val; }
    });
    inp.addEventListener('change', e => {
      const idx = parseInt(inp.closest('tr').dataset.idx);
      const field = inp.dataset.field;
      articoliAggiunti[idx][field] = e.target.value;
      aggiornaCalcoliRighe();
      aggiornaTotali();
      updateEquivDiscount();
    });
  });

  // Bind remove buttons
  body.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      articoliAggiunti.splice(idx, 1);
      renderTabellaArticoli();
      aggiornaTotali();
      updateEquivDiscount();
    });
  });

  applyColumnVisibility();
}

function fmtDec(n, d = 2, trim = true) {
  if (!Number.isFinite(n)) return '';
  let s = n.toFixed(d);
  if (trim) s = s.replace(/\.?0+$/, '');
  return s.replace('.', ',');
}

function aggiornaCalcoliRighe() {
  const body = document.getElementById('articoliBody');
  if (!body) return;

  body.querySelectorAll('tr[data-idx]').forEach(tr => {
    const idx = parseInt(tr.dataset.idx);
    const a = articoliAggiunti[idx];
    if (!a) return;
    const r = computeRow(a);

    const setCell = (col, val) => {
      const td = tr.querySelector(`td[data-col="${col}"]`);
      if (td) td.textContent = val;
    };

    setCell('totaleNetto', fmt€(r.totaleNettoUnit));
    setCell('granTot', fmt€(r.granTotRiga));

    const diffTd = tr.querySelector('td[data-col="diff"]');
    if (diffTd) {
      diffTd.textContent = fmt€(r.differenza);
      diffTd.className = r.differenza >= 0 ? 'tot-positive' : 'tot-negative';
    }
  });
}

function aggiornaTotali() {
  let totNetto = 0, totServizi = 0, totVenduto = 0, totDiff = 0;

  articoliAggiunti.forEach(a => {
    const r = computeRow(a);
    totNetto += r.conMargineUnit * r.qta;
    totServizi += r.granTotRiga;
    totVenduto += r.venduto;
    totDiff += r.differenza;
  });

  totNetto = roundTwo(totNetto);
  totServizi = roundTwo(totServizi);

  const card = document.getElementById('totaliCard');
  const el = document.getElementById('totaleGenerale');
  if (!el) return;

  if (!articoliAggiunti.length) { if (card) card.style.display = 'none'; return; }
  if (card) card.style.display = 'block';

  const vatRate = clamp(parseDec(smartSettings.vatRate ?? 22), 0, 100);
  const imponibile = totServizi;
  const iva = roundTwo(imponibile * vatRate / 100);
  const totIvato = roundTwo(imponibile + iva);

  let html = `<table style="border-collapse:collapse;width:100%;font-size:.86rem">`;
  html += `<tr><td>Totale netto (senza servizi)</td><td style="text-align:right;font-weight:700">${fmt€(totNetto)}</td></tr>`;
  html += `<tr><td>Totale complessivo (con trasp./inst.)</td><td style="text-align:right"><strong>${fmt€(totServizi)}</strong></td></tr>`;

  if (!smartSettings.hideVenduto)
    html += `<tr><td>Totale venduto</td><td style="text-align:right">${fmt€(totVenduto)}</td></tr>`;
  if (!smartSettings.hideDiff)
    html += `<tr><td>Totale diff. sconto</td><td style="text-align:right">${fmt€(totDiff)}</td></tr>`;

  if (smartSettings.showVAT) {
    html += `<tr><td>IVA (${vatRate.toFixed(1)}%)</td><td style="text-align:right">${fmt€(iva)}</td></tr>`;
    html += `<tr><td><strong>Totale + IVA</strong></td><td style="text-align:right"><strong style="color:var(--success);font-size:1.05rem">${fmt€(totIvato)}</strong></td></tr>`;
  }

  html += `</table>`;
  el.innerHTML = html;
}

function updateEquivDiscount() {
  const el = document.getElementById('smartEquivalentDiscount');
  if (!el) return;

  let base = 0, final = 0;
  articoliAggiunti.forEach(a => {
    const r = computeRow(a);
    base += a.prezzoLordo * r.qta;
    final += r.conMargineUnit * r.qta;
  });

  base = roundTwo(base);
  final = roundTwo(final);
  if (!base) { el.textContent = '—'; return; }
  const eq = clamp((1 - final / base) * 100, -9999, 9999);
  el.textContent = `${eq.toFixed(2)}%`;
}

// ───────────────────────────────────────────────
// COLUMN VISIBILITY
// ───────────────────────────────────────────────
function applyColumnVisibility() {
  const hide = (col, hidden) => {
    document.querySelectorAll(`[data-col="${col}"]`).forEach(el => el.classList.toggle('col-hidden', !!hidden));
  };

  const client = !!smartSettings.showClientDiscount;
  const smart = !!smartSettings.smartMode;

  hide('sconto1', client);
  hide('sconto2', client);
  hide('scontoCliente', !client);
  hide('margine', smart || client);
  hide('prezzoLordo', smart);
  hide('venduto', smart || smartSettings.hideVenduto);
  hide('diff', smart || smartSettings.hideDiff);
}

// ───────────────────────────────────────────────
// AGGIUNGI ARTICOLO
// ───────────────────────────────────────────────
function newArticoloFrom(base) {
  return {
    codice: base.codice,
    descrizione: base.descrizione,
    prezzoLordo: base.prezzoLordo,
    sconto: 0,
    sconto2: 0,
    margine: 0,
    scontoCliente: 0,
    costoTrasporto: autoCosti ? base.costoTrasporto : 0,
    costoInstallazione: autoCosti ? base.costoInstallazione : 0,
    quantita: 1,
    venduto: 0,
  };
}

function aggiungiDaListino() {
  const sel = document.getElementById('listinoSelect');
  if (!sel?.value) { showToast('⚠️ Nessun articolo selezionato'); return; }
  const item = listino.find(i => i.codice === sel.value);
  if (!item) return;

  // Hint disponibilità
  const dispRow = getDispRowForCodice(item.codice);
  if (dispRow) {
    const hint = document.getElementById('dispHint');
    if (hint) {
      const arr = arriviText(dispRow);
      hint.innerHTML = `<span class="disp-hint">📦 ${item.codice} — Disp: ${dispRow.disponibilita}${arr ? ' | ' + arr : ''}${dispRow.note ? ' | ' + dispRow.note : ''}</span>`;
      hint.style.display = 'block';
    }
  }

  articoliAggiunti.push(newArticoloFrom(item));
  renderTabellaArticoli();
  aggiornaTotali();
  updateEquivDiscount();
  showToast(`✅ Aggiunto: ${item.descrizione}`);
}

function aggiungiManuale() {
  const codice = document.getElementById('manCodice')?.value?.trim();
  const descrizione = document.getElementById('manDescrizione')?.value?.trim();
  const prezzoLordo = parseDec(document.getElementById('manPrezzo')?.value);
  const costoTrasporto = parseDec(document.getElementById('manTrasporto')?.value);
  const costoInstallazione = parseDec(document.getElementById('manInstallazione')?.value);

  if (!codice || !descrizione) { showToast('⚠️ Codice e descrizione obbligatori'); return; }

  articoliAggiunti.push({ codice, descrizione, prezzoLordo, sconto: 0, sconto2: 0, margine: 0,
    scontoCliente: 0, costoTrasporto, costoInstallazione, quantita: 1, venduto: 0 });

  document.getElementById('manCodice').value = '';
  document.getElementById('manDescrizione').value = '';
  document.getElementById('manPrezzo').value = '';
  document.getElementById('manTrasporto').value = '';
  document.getElementById('manInstallazione').value = '';

  renderTabellaArticoli();
  aggiornaTotali();
  updateEquivDiscount();
  showToast(`✅ Aggiunto manualmente: ${codice}`);
}

// ───────────────────────────────────────────────
// REPORT GENERATION
// ───────────────────────────────────────────────
function generaReport(opts = {}) {
  const { noMargine = false } = opts;
  const client = !!smartSettings.showClientDiscount;

  let lines = [];
  const dateStr = new Date().toLocaleDateString('it-IT', { day:'2-digit', month:'2-digit', year:'numeric' });
  lines.push(`PREVENTIVO — ${dateStr}`);
  lines.push('═'.repeat(40));
  lines.push('');

  let totNetto = 0, totComplessivo = 0;

  articoliAggiunti.forEach((a, i) => {
    const r = computeRow(a);
    const prezzoDisplay = noMargine ? r.totaleNettoUnit : r.conMargineUnit;

    lines.push(`${i+1}. ${a.codice} — ${a.descrizione}`);

    if (!smartSettings.hideDiscounts && !noMargine) {
      if (client) {
        lines.push(`   Sc. cliente: ${clamp(parseDec(a.scontoCliente||0),0,100).toFixed(2)}%`);
      } else {
        if (r.sconto1) lines.push(`   Sc.1: ${r.sconto1}%`);
        if (r.sconto2) lines.push(`   Sc.2: ${r.sconto2}%`);
        if (r.margine) lines.push(`   Marg.: ${r.margine}%`);
      }
    }

    lines.push(`   Prezzo netto: ${fmt€(prezzoDisplay)}`);
    lines.push(`   Qtà: ${r.qta}`);
    if (r.trasporto) lines.push(`   Trasporto: ${fmt€(r.trasporto)}`);
    if (r.installazione) lines.push(`   Installazione: ${fmt€(r.installazione)}`);
    lines.push(`   Totale riga: ${fmt€(r.granTotRiga)}`);

    if (!smartSettings.hideVenduto && !noMargine)
      lines.push(`   Venduto a: ${fmt€(r.venduto)}`);
    if (!smartSettings.hideDiff && !noMargine)
      lines.push(`   Diff. sconto: ${fmt€(r.differenza)}`);

    lines.push('');
    totNetto += prezzoDisplay * r.qta;
    totComplessivo += r.granTotRiga;
  });

  lines.push('─'.repeat(40));
  lines.push(`Totale netto:       ${fmt€(roundTwo(totNetto))}`);
  lines.push(`Totale complessivo: ${fmt€(roundTwo(totComplessivo))}`);

  if (smartSettings.showVAT) {
    const vat = clamp(parseDec(smartSettings.vatRate ?? 22), 0, 100);
    const iva = roundTwo(totComplessivo * vat / 100);
    lines.push(`IVA (${vat.toFixed(1)}%):        ${fmt€(iva)}`);
    lines.push(`TOTALE + IVA:       ${fmt€(roundTwo(totComplessivo + iva))}`);
  }

  return lines.join('\n');
}

function downloadTXT(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function openWhatsApp(content) {
  window.open('https://api.whatsapp.com/send?text=' + encodeURIComponent(content), '_blank');
}

function mostraPreview(content) {
  const el = document.getElementById('reportPreview');
  if (!el) return;
  el.textContent = content;
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ───────────────────────────────────────────────
// SCONTO CLIENTE MODE
// ───────────────────────────────────────────────
function computeEquivClientDiscount(a) {
  const pL = parseDec(a.prezzoLordo || 0);
  if (pL <= 0) return 0;
  const r = computeRow({ ...a, __skipClient: true });
  return clamp((1 - r.conMargineUnit / pL) * 100, 0, 100);
}

function applyClientDiscountMode(enabled) {
  articoliAggiunti = articoliAggiunti.map(a => {
    const item = { ...a };
    if (enabled) {
      if (item._bakSconto === undefined) item._bakSconto = parseDec(item.sconto || 0);
      if (item._bakSconto2 === undefined) item._bakSconto2 = parseDec(item.sconto2 || 0);
      if (item._bakMargine === undefined) item._bakMargine = parseDec(item.margine || 0);
      item.scontoCliente = computeEquivClientDiscount(item);
      item.sconto = 0; item.sconto2 = 0; item.margine = 0;
    } else {
      if (item._bakSconto !== undefined) item.sconto = item._bakSconto;
      if (item._bakSconto2 !== undefined) item.sconto2 = item._bakSconto2;
      if (item._bakMargine !== undefined) item.margine = item._bakMargine;
    }
    return item;
  });
  renderTabellaArticoli();
  aggiornaTotali();
  updateEquivDiscount();
}

// ───────────────────────────────────────────────
// BIND SMART CONTROLS
// ───────────────────────────────────────────────
function bindSmartControls() {
  const ids = ['toggleSmartMode','toggleShowVAT','toggleHideVenduto','toggleHideDiff',
                'toggleHideDiscounts','toggleShowClientDiscount','toggleAutoCosti','vatRate'];

  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    // init value
    if (el.type === 'checkbox') {
      if (id === 'toggleSmartMode') el.checked = smartSettings.smartMode;
      else if (id === 'toggleShowVAT') el.checked = smartSettings.showVAT;
      else if (id === 'toggleHideVenduto') el.checked = smartSettings.hideVenduto;
      else if (id === 'toggleHideDiff') el.checked = smartSettings.hideDiff;
      else if (id === 'toggleHideDiscounts') el.checked = smartSettings.hideDiscounts;
      else if (id === 'toggleShowClientDiscount') el.checked = smartSettings.showClientDiscount;
      else if (id === 'toggleAutoCosti') el.checked = autoCosti;
    } else {
      el.value = smartSettings.vatRate;
    }

    el.addEventListener('change', () => {
      const prevClient = !!smartSettings.showClientDiscount;

      smartSettings.smartMode = !!document.getElementById('toggleSmartMode')?.checked;
      smartSettings.showVAT = !!document.getElementById('toggleShowVAT')?.checked;
      smartSettings.hideVenduto = !!document.getElementById('toggleHideVenduto')?.checked;
      smartSettings.hideDiff = !!document.getElementById('toggleHideDiff')?.checked;
      smartSettings.hideDiscounts = !!document.getElementById('toggleHideDiscounts')?.checked;
      smartSettings.showClientDiscount = !!document.getElementById('toggleShowClientDiscount')?.checked;
      smartSettings.vatRate = clamp(parseDec(document.getElementById('vatRate')?.value || '22'), 0, 100);
      autoCosti = !!document.getElementById('toggleAutoCosti')?.checked;

      if (smartSettings.smartMode) {
        smartSettings.hideVenduto = smartSettings.hideDiff = smartSettings.hideDiscounts = true;
      }

      saveSettings();

      if (prevClient !== smartSettings.showClientDiscount) {
        applyClientDiscountMode(smartSettings.showClientDiscount);
        return;
      }

      applyColumnVisibility();
      aggiornaCalcoliRighe();
      aggiornaTotali();
      updateEquivDiscount();
    });
  });
}

// ───────────────────────────────────────────────
// INIT
// ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  loadSettings();
  initTabs();

  // Theme toggle
  document.getElementById('btnTheme')?.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    setTheme(!dark);
  });

  // CSV Listino
  document.getElementById('csvFileInput')?.addEventListener('change', handleCSVUpload);
  document.getElementById('searchListino')?.addEventListener('input', aggiornaListinoSelect);
  document.getElementById('btnAddFromListino')?.addEventListener('click', aggiungiDaListino);
  document.getElementById('btnAddManual')?.addEventListener('click', aggiungiManuale);

  document.getElementById('btnLoadSavedCSV')?.addEventListener('click', async () => {
    const p = await idbGet('listino').catch(() => null);
    if (!p?.data?.length) { showToast('⚠️ Nessun listino salvato'); return; }
    listino = p.data;
    aggiornaListinoSelect();
    updateListinoStats();
    showToast(`✅ Listino caricato: ${listino.length} articoli`);
  });

  document.getElementById('btnClearSavedCSV')?.addEventListener('click', async () => {
    await idbDel('listino').catch(() => {});
    await updateSavedCsvInfo();
    showToast('🗑️ Listino salvato cancellato');
  });

  // XLSX Situazione
  document.getElementById('xlsxFileInput')?.addEventListener('change', handleXLSXUpload);

  document.getElementById('btnLoadSavedXLSX')?.addEventListener('click', async () => {
    const p = await idbGet('situazione').catch(() => null);
    if (!p?.data?.length) { showToast('⚠️ Nessuna situazione salvata'); return; }
    situazione = p.data;
    renderDispTable();
    aggiornaListinoSelect();
    showToast(`✅ Situazione caricata: ${situazione.length} articoli`);
  });

  document.getElementById('btnClearSavedXLSX')?.addEventListener('click', async () => {
    await idbDel('situazione').catch(() => {});
    await updateSavedXlsxInfo();
    showToast('🗑️ Situazione salvata cancellata');
  });

  // Filtri disponibilità
  document.getElementById('searchDisp')?.addEventListener('input', e => {
    _dispSearch = e.target.value;
    renderDispTable();
  });

  document.getElementById('filterDisp')?.addEventListener('change', e => {
    _dispFilter = e.target.value;
    renderDispTable();
  });

  document.getElementById('btnExportDisp')?.addEventListener('click', exportDispCSV);

  // Export preventivo
  document.getElementById('btnWA')?.addEventListener('click', () => {
    const r = generaReport();
    mostraPreview(r);
    openWhatsApp(r);
  });

  document.getElementById('btnTXT')?.addEventListener('click', () => {
    const r = generaReport();
    mostraPreview(r);
    downloadTXT(r, `preventivo_${new Date().toISOString().slice(0,10)}.txt`);
    showToast('📄 TXT scaricato');
  });

  document.getElementById('btnWANoMarg')?.addEventListener('click', () => {
    const r = generaReport({ noMargine: true });
    mostraPreview(r);
    openWhatsApp(r);
  });

  document.getElementById('btnTXTNoMarg')?.addEventListener('click', () => {
    const r = generaReport({ noMargine: true });
    mostraPreview(r);
    downloadTXT(r, `preventivo_nomarg_${new Date().toISOString().slice(0,10)}.txt`);
    showToast('📄 TXT (no marg.) scaricato');
  });

  document.getElementById('btnCopyClip')?.addEventListener('click', async () => {
    const r = generaReport();
    mostraPreview(r);
    try {
      await navigator.clipboard.writeText(r);
      showToast('📋 Copiato negli appunti!');
    } catch (_) { showToast('⚠️ Copia non supportata da questo browser'); }
  });

  document.getElementById('btnClearAll')?.addEventListener('click', () => {
    if (!articoliAggiunti.length) return;
    if (!confirm('Svuotare la lista articoli?')) return;
    articoliAggiunti = [];
    renderTabellaArticoli();
    aggiornaTotali();
    updateEquivDiscount();
    document.getElementById('reportPreview').style.display = 'none';
    showToast('🗑️ Lista svuotata');
  });

  // Smart controls
  bindSmartControls();

  // Initial render
  renderTabellaArticoli();
  aggiornaTotali();
  applyColumnVisibility();
  updateEquivDiscount();

  // Load persisted data
  await initListinoMemory();
  await initXLSXMemory();
});
