# CSVXpressSmart 2026

**PWA per preventivi, ordini e gestione disponibilità settimanale.**

---

## Novità rispetto alla v1

| Feature | v1 | v2 (2026) |
|---|---|---|
| Listino CSV | ✅ | ✅ |
| Memoria listino (IndexedDB) | ✅ | ✅ |
| Preventivo con sconti/margine | ✅ | ✅ |
| Modalità Smart Cliente | ✅ | ✅ |
| Sconto Cliente equivalente | ✅ | ✅ |
| Report WhatsApp / TXT | ✅ | ✅ |
| **Situazione settimanale XLSX** | ❌ | ✅ |
| **Disponibilità inline nel preventivo** | ❌ | ✅ |
| **Filtri disponibilità (esauriti, in arrivo…)** | ❌ | ✅ |
| **Export CSV situazione filtrata** | ❌ | ✅ |
| **Dark mode** | ❌ | ✅ |
| **Copia preventivo negli appunti** | ❌ | ✅ |
| **Toast notifications** | ❌ | ✅ |
| **UI tab-based (Listino / Disponibilità / Preventivo)** | ❌ | ✅ |

---

## Struttura file

```
CSVXpressSmart_2026/
├── index.html          ← App shell
├── manifest.json       ← PWA manifest
├── service-worker.js   ← Service Worker (offline / cache)
├── css/
│   └── style.css       ← Design system completo + dark mode
├── js/
│   └── app.js          ← Tutta la logica
└── icon/
    ├── icon-192.png    ← Icona PWA 192×192
    └── icon-512.png    ← Icona PWA 512×512
```

---

## Come usare

### 1. Tab "Listino"
- Carica il CSV con le colonne:
  ```
  Codice;Descrizione;PrezzoLordo;CostoTrasporto;CostoInstallazione
  ```
- Attiva "Ricorda listino" per non doverlo ricaricare ad ogni sessione.

### 2. Tab "Disponibilità"
- Carica il file **XLSX settimanale** (Situazione Settimanale) direttamente dal file `.xlsx` o come `.csv`.
- Il parser legge la struttura standard (intestazioni su 3 righe, poi dati).
- Colonne lette:
  - Codice, Descrizione, Disp., Arrivi (Sett.15, Sett.18, Maggio, Giugno), Note, Prenotazioni
- Filtri rapidi: tutti / disponibili / esauriti / in arrivo / con note
- Esporta la vista filtrata come CSV.

### 3. Tab "Preventivo"
- Cerca e aggiungi articoli dal listino. Nel menu a tendina viene mostrata anche la **disponibilità attuale** (se caricata).
- Dopo aver aggiunto un articolo, un banner mostra disponibilità, arrivi e note.
- Colonna **Disp.** in tabella con badge colorato:
  - 🟢 verde = disponibile (>5)
  - 🟡 giallo = scorta bassa (1–5)
  - 🔴 rosso = esaurito
  - 🩵 turchese = esaurito ma arrivi previsti
- Imposta sconti (Sc.1, Sc.2), margine, IVA, trasporto, installazione.
- **Modalità Cliente** nasconde prezzi interni nel report.
- **Modalità Sconto Cliente** calcola automaticamente lo sconto equivalente.
- Export: WhatsApp, TXT, Copia appunti — versioni "con" e "senza" margine.

---

## Deploy

L'app è una **PWA statica**: basta caricare la cartella su qualsiasi hosting statico (GitHub Pages, Netlify, Vercel, server Apache/Nginx).

```bash
# GitHub Pages esempio
git init
git add .
git commit -m "CSVXpressSmart 2026 v2.0.0"
git remote add origin https://github.com/TUO_USER/CSVXpressSmart_2026.git
git push -u origin main
# poi abilita GitHub Pages su /main root
```

---

## Icone

Copia le icone dalla v1 (CSVXpressSmart-192.png → icon/icon-192.png, ecc.) oppure genera nuove icone su https://realfavicongenerator.net

---

## Dipendenze CDN

- [PapaParse 5.3.2](https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.3.2/papaparse.min.js) — parsing CSV
- [SheetJS (xlsx) 0.18.5](https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js) — lettura XLSX

Entrambe vengono cachate dal Service Worker per uso offline.
