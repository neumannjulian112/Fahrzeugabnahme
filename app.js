/* ============================================================
   Abnahme — Mobile Prüf-App
   Matrix-Modus (Mehrfahrzeug) + Wizard-Layout (eine Seite pro Position)
   ============================================================ */
(function () {
  'use strict';

  const DB_NAME = 'abnahme-db';
  const DB_VERSION = 1;
  const STORE = 'sessions';
  const LS_LAST = 'abnahme:lastSessionId';
  const SAVE_DEBOUNCE_MS = 400;
  const COMPLETED_THRESHOLD = 0.95;

  const state = {
    sessionId: null,
    filename: '',
    fileBuffer: null,
    mode: 'list',                  // 'list' oder 'matrix'
    sheets: [],
    matrix: null,                  // { vehicles: [...], sheets: [...] }
    annotations: {},
    currentSheetIdx: 0,
    currentVehicle: null,
    subVehicles: [],               // Bis zu 3 untergeordnete Fahrzeuge (Sitzungs-weit)
    pendingApplySubs: new Set(),   // Pro Position vor-markierte Subs
    currentItemIdx: 0,             // Index in der aktuellen gefilterten Item-Liste
    visibleItems: [],              // Im Wizard angezeigte Items (gefiltert)
    wizardFilter: 'all',
    dirty: false,
    exported: false,
    createdAt: 0,
    modifiedAt: 0,
    screen: 'start',
    screenStack: []
  };

  const $ = sel => document.querySelector(sel);
  const els = {
    backBtn: $('#backBtn'),
    headerEyebrow: $('#headerEyebrow'),
    headerTitle: $('#headerTitle'),
    headerStatus: $('#headerStatus'),
    saveText: $('#saveText'),
    progressContainer: $('#progressContainer'),
    progressFill: $('#progressFill'),
    statDone: $('#statDone'),
    statDefect: $('#statDefect'),
    statOpen: $('#statOpen'),
    statPercent: $('#statPercent'),
    screens: {
      start: $('#screen-start'),
      vehicles: $('#screen-vehicles'),
      sheets: $('#screen-sheets'),
      items: $('#screen-items'),
      sessions: $('#screen-sessions')
    },
    fileInput: $('#fileInput'),
    resumeBtn: $('#resumeBtn'),
    resumeSubtitle: $('#resumeSubtitle'),
    eboxDownloadBtn: $('#eboxDownloadBtn'),
    eboxUploadBtn: $('#eboxUploadBtn'),
    eboxDownloadUrl: $('#eboxDownloadUrl'),
    eboxUploadUrl: $('#eboxUploadUrl'),
    eboxSaveBtn: $('#eboxSaveBtn'),
    eboxResetBtn: $('#eboxResetBtn'),
    manageBtn: $('#manageBtn'),
    vehiclesFilename: $('#vehiclesFilename'),
    vehiclesMeta: $('#vehiclesMeta'),
    vehicleList: $('#vehicleList'),
    completedSection: $('#completedSection'),
    completedSummary: $('#completedSummary'),
    completedList: $('#completedList'),
    vehiclesExportBtn: $('#vehiclesExportBtn'),
    vehiclesCloseBtn: $('#vehiclesCloseBtn'),
    filenameTitle: $('#filenameTitle'),
    filenameMeta: $('#filenameMeta'),
    sheetList: $('#sheetList'),
    exportBtn: $('#exportBtn'),
    closeFileBtn: $('#closeFileBtn'),
    // Wizard
    wizPos: $('#wizPos'),
    wizTotal: $('#wizTotal'),
    wizContext: $('#wizContext'),
    wizCard: $('#wizCard'),
    wizEmpty: $('#wizEmpty'),
    wizPrev: $('#wizPrev'),
    wizNext: $('#wizNext'),
    wizProgressFill: $('#wizProgressFill'),
    wizOverviewBtn: $('#wizOverviewBtn'),
    sessionList: $('#sessionList'),
    sessionEmpty: $('#sessionEmpty'),
    toast: $('#toast'),
    modal: $('#modal'),
    modalTitle: $('#modalTitle'),
    modalText: $('#modalText'),
    modalCancel: $('#modalCancel'),
    modalOk: $('#modalOk')
  };

  /* ----- IndexedDB ----- */
  let _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('modifiedAt', 'modifiedAt');
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
    return _dbPromise;
  }
  async function idbPut(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }
  async function idbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = e => reject(e.target.error);
    });
  }
  async function idbAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const arr = req.result || [];
        arr.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
        resolve(arr);
      };
      req.onerror = e => reject(e.target.error);
    });
  }
  async function idbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  /* ----- Auto-Save ----- */
  let saveTimer = null;
  function scheduleSave() {
    state.dirty = true;
    state.exported = false;
    state.modifiedAt = Date.now();
    setSaveStatus('dirty');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  async function flushSave() {
    if (!state.sessionId) return;
    setSaveStatus('saving');
    try {
      const stats = computeOverallStats();
      const record = {
        id: state.sessionId, filename: state.filename, fileBuffer: state.fileBuffer,
        mode: state.mode, annotations: state.annotations,
        createdAt: state.createdAt, modifiedAt: state.modifiedAt,
        exported: state.exported, stats
      };
      await idbPut(record);
      try { localStorage.setItem(LS_LAST, state.sessionId); } catch (_) {}
      state.dirty = false;
      setSaveStatus('ok');
    } catch (err) {
      console.error('Speichern fehlgeschlagen:', err);
      setSaveStatus('error');
      toast('Speichern fehlgeschlagen.', 'error');
    }
  }
  function setSaveStatus(s) {
    els.headerStatus.classList.remove('saving', 'error', 'dirty');
    if (s === 'saving') { els.headerStatus.classList.add('saving'); els.saveText.textContent = 'Speichert…'; }
    else if (s === 'dirty') { els.headerStatus.classList.add('dirty'); els.saveText.textContent = 'Ungespeichert'; }
    else if (s === 'error') { els.headerStatus.classList.add('error'); els.saveText.textContent = 'Fehler'; }
    else if (s === 'ok') { els.saveText.textContent = 'Gespeichert'; }
    else { els.saveText.textContent = s || 'Bereit'; }
  }

  /* ----- Helpers ----- */
  function cellStr(v) {
    if (v == null) return '';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return String(v);
      return String(v).replace('.', ',');
    }
    return String(v).trim();
  }
  function isVehicleHeader(s) {
    if (!s) return false;
    return /^[A-ZÄÖÜ]{1,5}(?:[-/][A-Z0-9]+)?\s*\d{1,3}$/i.test(String(s).trim());
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ----- Matrix-Erkennung ----- */
  function findMatrixHeaderRow(sheet, maxRows = 10) {
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    for (let r = range.s.r; r <= Math.min(range.s.r + maxRows, range.e.r); r++) {
      let vehicleCount = 0;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        if (isVehicleHeader(cellStr(cell.v))) vehicleCount++;
      }
      if (vehicleCount >= 2) return r;
    }
    return -1;
  }

  function isCellDisabled(cell) {
    if (!cell || !cell.s) return false;
    const s = cell.s;
    if (s.patternType !== 'solid') return false;
    const fg = s.fgColor;
    if (!fg) return false;
    if (fg.theme != null && typeof fg.tint === 'number' && fg.tint < -0.05) return true;
    if (fg.rgb && typeof fg.rgb === 'string') {
      const hex = fg.rgb.length === 8 ? fg.rgb.slice(2) : fg.rgb;
      if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const avg = (r + g + b) / 3;
        const spread = Math.max(Math.abs(r - avg), Math.abs(g - avg), Math.abs(b - avg));
        if (spread < 16 && avg > 100 && avg < 230) return true;
      }
    }
    return false;
  }

  function parseMatrixSheet(wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return null;
    const headerRowIdx = findMatrixHeaderRow(ws);
    if (headerRowIdx < 0) return null;

    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    const headerRow = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: headerRowIdx, c })];
      headerRow[c] = cell ? cellStr(cell.v) : '';
    }

    const cols = {
      pos: -1, anz: -1, beistell: -1, titel: -1,
      ausschluss: -1, baubesprechung: -1, lagerort: -1, vehicles: []
    };

    for (let c = range.s.c; c <= range.e.c; c++) {
      const h = headerRow[c] || '';
      const hl = h.toLowerCase();
      if (!h) continue;
      if (isVehicleHeader(h)) { cols.vehicles.push({ col: c, name: h }); continue; }
      if (cols.pos === -1 && /^(pos\.?|nr\.?|nummer|position|#|lfd\.?\s*nr\.?)$/i.test(h)) { cols.pos = c; continue; }
      if (cols.anz === -1 && /^(anz\.?|anzahl|stk\.?|st[üu]ck)$/i.test(h)) { cols.anz = c; continue; }
      if (cols.beistell === -1 && /bei.?stell/i.test(h)) { cols.beistell = c; continue; }
      if (cols.ausschluss === -1 && /aus.?schluss/i.test(hl)) { cols.ausschluss = c; continue; }
      if (cols.baubesprechung === -1 && /baubesprechung|bemerk.*planung|vorab/i.test(hl)) { cols.baubesprechung = c; continue; }
      if (cols.lagerort === -1 && /lagerort|beladeplan/i.test(hl)) { cols.lagerort = c; continue; }
      if (cols.titel === -1) { cols.titel = c; continue; }
    }
    if (!cols.vehicles.length || cols.titel === -1) return null;

    for (const v of cols.vehicles) {
      v.fgnr = ''; v.kennz = ''; v.kennzColor = '';
      for (let r = headerRowIdx + 1; r <= Math.min(headerRowIdx + 2, range.e.r); r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c: v.col })];
        const val = cell ? cellStr(cell.v) : '';
        if (!val) continue;
        if (!v.fgnr) v.fgnr = val;
        else if (!v.kennz) {
          v.kennz = val;
          // Hintergrundfarbe der Kennzeichen-Zelle erfassen (als RGB-Hex ohne Alpha)
          if (cell && cell.s && cell.s.patternType === 'solid' && cell.s.fgColor && cell.s.fgColor.rgb) {
            const rgb = cell.s.fgColor.rgb;
            const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
            if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
              // weiß und schwarz nicht als „Markierung" behandeln
              const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
              const sum = r + g + b;
              if (sum > 30 && sum < 720) v.kennzColor = '#' + hex.toUpperCase();
            }
          }
        }
      }
    }

    const rows = [];
    let currentSection = '';
    for (let r = headerRowIdx + 1; r <= range.e.r; r++) {
      const titel = cellStr((ws[XLSX.utils.encode_cell({ r, c: cols.titel })] || {}).v);
      const pos = cols.pos >= 0 ? cellStr((ws[XLSX.utils.encode_cell({ r, c: cols.pos })] || {}).v) : '';
      const anz = cols.anz >= 0 ? cellStr((ws[XLSX.utils.encode_cell({ r, c: cols.anz })] || {}).v) : '';
      if (!titel) continue;

      let anyVehicleCell = false;
      for (const v of cols.vehicles) {
        const cell = ws[XLSX.utils.encode_cell({ r, c: v.col })];
        if (cell && cellStr(cell.v) !== '') { anyVehicleCell = true; break; }
      }

      const isSection = !pos && !anyVehicleCell && (anz === '*' || /^(los\b|gruppe\b|kapitel\b)/i.test(titel) || titel.length < 80);
      if (isSection) { currentSection = titel; continue; }
      if (!pos && !anyVehicleCell) continue;

      const cells = {};
      for (const v of cols.vehicles) {
        const cell = ws[XLSX.utils.encode_cell({ r, c: v.col })];
        cells[v.name] = { value: cell ? cellStr(cell.v) : '', disabled: isCellDisabled(cell) };
      }

      rows.push({
        rowIdx: r,
        section: currentSection,
        pos, anz,
        beistell: cols.beistell >= 0 ? cellStr((ws[XLSX.utils.encode_cell({ r, c: cols.beistell })] || {}).v) : '',
        lagerort: cols.lagerort >= 0 ? cellStr((ws[XLSX.utils.encode_cell({ r, c: cols.lagerort })] || {}).v) : '',
        ausschluss: cols.ausschluss >= 0 ? cellStr((ws[XLSX.utils.encode_cell({ r, c: cols.ausschluss })] || {}).v) : '',
        baubesprechung: cols.baubesprechung >= 0 ? cellStr((ws[XLSX.utils.encode_cell({ r, c: cols.baubesprechung })] || {}).v) : '',
        titel, cells
      });
    }
    return { name: sheetName, headerRowIdx, cols, rows };
  }

  function parseWorkbookMatrix(buffer) {
    const wb = XLSX.read(buffer, { type: 'array', cellStyles: true });
    const matrixSheets = [];
    let allVehicles = null;
    for (const name of wb.SheetNames) {
      if (wb.Workbook && wb.Workbook.Sheets) {
        const meta = wb.Workbook.Sheets.find(s => s.name === name);
        if (meta && (meta.Hidden === 1 || meta.Hidden === 2)) continue;
      }
      const parsed = parseMatrixSheet(wb, name);
      if (parsed && parsed.rows.length > 0) {
        matrixSheets.push(parsed);
        if (!allVehicles) allVehicles = parsed.cols.vehicles.map(v => ({ ...v }));
      }
    }
    if (!matrixSheets.length || !allVehicles) return null;
    return { vehicles: allVehicles, sheets: matrixSheets };
  }

  /* ----- Listen-Modus (vereinfachter Fallback) ----- */
  function parseWorkbookList(buffer) {
    const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
    const sheets = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      if (wb.Workbook && wb.Workbook.Sheets) {
        const meta = wb.Workbook.Sheets.find(s => s.name === name);
        if (meta && (meta.Hidden === 1 || meta.Hidden === 2)) continue;
      }
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '', raw: false });
      if (!rows.length) continue;
      // einfache Header-Erkennung
      let headerRowIdx = 0, bestScore = 0;
      for (let r = 0; r < Math.min(rows.length, 15); r++) {
        const row = rows[r] || [];
        let s = 0;
        for (const c of row) {
          const t = cellStr(c);
          if (!t) continue;
          if (/pr[üu]f|bezeichnung|status|bemerk|nr\.?|pos\.?/i.test(t)) s += 5;
          else if (t.length > 1 && t.length < 30) s += 1;
        }
        if (s > bestScore) { bestScore = s; headerRowIdx = r; }
      }
      const headerRow = rows[headerRowIdx] || [];
      // Spalten: Erste mit Text längerem Inhalt = Titel
      let titleCol = -1, posCol = -1;
      for (let c = 0; c < headerRow.length; c++) {
        const h = cellStr(headerRow[c]);
        if (!h) continue;
        if (posCol === -1 && /^(nr\.?|pos\.?|nummer|#)$/i.test(h)) { posCol = c; continue; }
        if (titleCol === -1) { titleCol = c; }
      }
      if (titleCol === -1) continue;
      const items = [];
      for (let r = headerRowIdx + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const titel = cellStr(row[titleCol]);
        if (!titel) continue;
        items.push({
          rowIdx: r,
          pos: posCol >= 0 ? cellStr(row[posCol]) : '',
          titel,
          baubesprechung: '',
          origValue: ''
        });
      }
      sheets.push({ name, items, titleCol, posCol, headerRowIdx });
    }
    return sheets;
  }

  /* ----- Excel-Wert ↔ Status/Notiz ----- */
  function parseExcelCellValue(value) {
    const v = (value || '').trim();
    if (!v) return null;
    const m = v.match(/^(i\.?\s*o\.?\.?|in\s*ordnung|ok|erledigt|fertig|n\.?\s*i\.?\s*o\.?\.?|nicht\s*i\.?\s*o\.?|nicht\s*in\s*ordnung|mangel|m[äa]ngel|defekt|fehler|offen|entf[äa]llt)\b[\s:.\-,]*/i);
    if (m) {
      const tok = m[1].toLowerCase().replace(/[\s.]/g, '');
      const rest = v.slice(m[0].length).trim();
      if (/^(io|inordnung|ok|erledigt|fertig)$/.test(tok)) return { status: 'done', note: rest };
      if (/^(nio|nichtio|nichtinordnung|mangel|m[äa]ngel|defekt|fehler)$/.test(tok)) return { status: 'defect', note: rest };
      if (tok === 'offen') return { status: 'open', note: rest };
      if (/^entf/.test(tok)) return { status: 'open', note: rest || 'entfällt' };
    }
    return { status: 'open', note: v };
  }
  function formatExcelCellValue(status, note, originalNote) {
    // Wenn die ursprüngliche Excel-Notiz erhalten bleiben soll und eine eigene Mängel-Notiz dazu kommt
    const n = (note || '').trim();
    const orig = (originalNote || '').trim();
    if (status === 'done') {
      // iO + ggf. Original-Anmerkung + ggf. neue Mängel-Notiz (wäre kombiniert)
      const parts = [];
      if (orig) parts.push(orig);
      if (n) parts.push(n);
      return parts.length ? `iO ${parts.join(' / ')}` : 'iO';
    }
    if (status === 'defect') {
      const parts = [];
      if (orig) parts.push(orig);
      if (n) parts.push(n);
      return parts.length ? `Mangel ${parts.join(' / ')}` : 'Mangel';
    }
    if (status === 'open') {
      return n || orig || '';
    }
    return '';
  }

  /* ----- Datei laden ----- */
  async function loadFromArrayBuffer(buffer, filename) {
    if (!buffer || !filename) return;
    try {
      const matrix = parseWorkbookMatrix(buffer);
      const sessionId = makeId(filename);
      Object.assign(state, {
        sessionId, filename, fileBuffer: buffer, annotations: {},
        currentSheetIdx: 0, currentVehicle: null, subVehicles: [], pendingApplySubs: new Set(), currentItemIdx: 0,
        exported: false, dirty: false,
        createdAt: Date.now(), modifiedAt: Date.now(), screenStack: []
      });
      state.modifiedAt = state.createdAt;

      if (matrix) {
        state.mode = 'matrix';
        state.matrix = matrix;
        state.sheets = [];
        // Bereits in der Excel eingetragene Werte als Annotationen übernehmen,
        // damit "iO"-Einträge etc. sofort als erledigt im Fortschritt zählen.
        for (const sh of matrix.sheets) {
          if (!state.annotations[sh.name]) state.annotations[sh.name] = {};
          for (const row of sh.rows) {
            const rowAnn = {};
            for (const veh of matrix.vehicles) {
              const cell = row.cells[veh.name];
              if (!cell || cell.disabled) continue;
              const parsed = parseExcelCellValue(cell.value);
              if (!parsed) continue;
              if (parsed.status === 'open' && !parsed.note) continue;
              // Markiere die Annotation als „aus der Datei übernommen", damit der
              // Wizard sie nicht zusätzlich als „Bestehender Eintrag" anzeigt
              // und der Export bei reinem "iO" ohne Notiz auch wieder nur "iO" schreibt.
              rowAnn[veh.name] = { status: parsed.status, note: parsed.note || '', fromFile: true };
            }
            if (Object.keys(rowAnn).length) state.annotations[sh.name][row.rowIdx] = rowAnn;
          }
        }
      } else {
        state.mode = 'list';
        state.matrix = null;
        const sheets = parseWorkbookList(buffer);
        if (!sheets.length) {
          toast('Keine Prüfpunkte erkannt.', 'error');
          return;
        }
        state.sheets = sheets;
      }

      await flushSave();
      try { localStorage.setItem(LS_LAST, sessionId); } catch (_) {}

      if (state.mode === 'matrix') {
        navigateTo('vehicles');
        const total = state.matrix.sheets.reduce((s, sh) => s + sh.rows.length, 0);
        // Format kurz anzeigen: xlsm (mit Makros) wird auch als xlsm exportiert
        let formatHint = 'xlsx';
        try {
          const probe = fflate.unzipSync(new Uint8Array(buffer));
          if (probe['xl/vbaProject.bin'] || (probe['[Content_Types].xml'] && /macroEnabled/i.test(strFromU8(probe['[Content_Types].xml'])))) {
            formatHint = 'xlsm (mit Makros)';
          }
        } catch (_) {}
        toast(`${state.matrix.vehicles.length} Fahrzeuge · ${total} Prüfkriterien · ${formatHint}`, 'success');
      } else {
        navigateTo('sheets');
      }
    } catch (err) {
      console.error(err);
      toast('Datei konnte nicht gelesen werden.', 'error');
    }
  }

  function makeId(filename) {
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
  }

  async function loadFromFile(file) {
    if (!file) return;
    setSaveStatus('saving');
    els.saveText.textContent = 'Liest…';
    try {
      const buffer = await file.arrayBuffer();
      await loadFromArrayBuffer(buffer, file.name || 'datei.xlsx');
    } catch (err) {
      console.error(err);
      toast('Datei konnte nicht geladen werden.', 'error');
      setSaveStatus('ok');
    }
  }
  async function loadFromUrl(url) {
    if (!url) return;
    setSaveStatus('saving');
    els.saveText.textContent = 'Lädt…';
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buffer = await res.arrayBuffer();
      let filename = url.split('/').pop() || 'datei.xlsx';
      filename = decodeURIComponent(filename.split('?')[0]);
      if (!/\.xls[mx]?$/i.test(filename)) filename += '.xlsx';
      await loadFromArrayBuffer(buffer, filename);
    } catch (err) {
      console.error(err);
      setSaveStatus('ok');
      toast('URL konnte nicht geladen werden (CORS?).', 'error');
    }
  }
  async function loadSession(record) {
    if (!record) return;
    Object.assign(state, {
      sessionId: record.id, filename: record.filename, fileBuffer: record.fileBuffer,
      annotations: record.annotations || {},
      createdAt: record.createdAt || Date.now(), modifiedAt: record.modifiedAt || Date.now(),
      exported: !!record.exported, dirty: false,
      currentSheetIdx: 0, currentVehicle: null, subVehicles: [], pendingApplySubs: new Set(), currentItemIdx: 0,
      screenStack: [], mode: record.mode || 'list'
    });
    if (state.mode === 'matrix') {
      state.matrix = parseWorkbookMatrix(record.fileBuffer);
      state.sheets = [];
      setSaveStatus('ok');
      try { localStorage.setItem(LS_LAST, record.id); } catch (_) {}
      navigateTo('vehicles');
    } else {
      state.matrix = null;
      state.sheets = parseWorkbookList(record.fileBuffer);
      setSaveStatus('ok');
      try { localStorage.setItem(LS_LAST, record.id); } catch (_) {}
      navigateTo('sheets');
    }
  }
  async function checkResume() {
    try {
      const lastId = localStorage.getItem(LS_LAST);
      if (!lastId) return;
      const rec = await idbGet(lastId);
      if (!rec) return;
      const stats = rec.stats || {};
      const dateStr = formatDateTime(rec.modifiedAt || rec.createdAt || Date.now());
      els.resumeBtn.hidden = false;
      els.resumeSubtitle.textContent = `${rec.filename} · ${stats.done || 0}/${stats.total || 0} erledigt · ${stats.defect || 0} Mängel · ${dateStr}`;
      els.resumeBtn.onclick = () => loadSession(rec);
    } catch (_) {}
  }
  function formatDateTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ----- Annotations ----- */
  function getAnnotation(sheetName, rowIdx, vehicleName) {
    const sa = state.annotations[sheetName];
    if (!sa) return { status: 'open', note: '' };
    const ra = sa[rowIdx];
    if (!ra) return { status: 'open', note: '' };
    if (state.mode === 'matrix') return ra[vehicleName] || { status: 'open', note: '' };
    return ra;
  }
  function setAnnotation(sheetName, rowIdx, patch, vehicleName) {
    if (!state.annotations[sheetName]) state.annotations[sheetName] = {};
    if (state.mode === 'matrix') {
      if (!state.annotations[sheetName][rowIdx]) state.annotations[sheetName][rowIdx] = {};
      const cur = state.annotations[sheetName][rowIdx][vehicleName] || { status: 'open', note: '' };
      const next = { ...cur, ...patch };
      // Sobald der User aktiv etwas ändert, ist es keine reine Datei-Übernahme mehr
      delete next.fromFile;
      if (next.status === 'open' && !next.note) {
        delete state.annotations[sheetName][rowIdx][vehicleName];
        if (Object.keys(state.annotations[sheetName][rowIdx]).length === 0) {
          delete state.annotations[sheetName][rowIdx];
        }
      } else {
        state.annotations[sheetName][rowIdx][vehicleName] = next;
      }
    } else {
      const cur = state.annotations[sheetName][rowIdx] || { status: 'open', note: '' };
      const next = { ...cur, ...patch };
      delete next.fromFile;
      if (next.status === 'open' && !next.note) delete state.annotations[sheetName][rowIdx];
      else state.annotations[sheetName][rowIdx] = next;
    }
    scheduleSave();
  }

  /* ----- Stats ----- */
  function getRelevantRows(sheetName, vehicleName) {
    if (state.mode !== 'matrix') return [];
    const sh = state.matrix.sheets.find(s => s.name === sheetName);
    if (!sh) return [];
    return sh.rows.filter(r => {
      const c = r.cells[vehicleName];
      return c && !c.disabled;
    });
  }

  function computeVehicleStats(vehicleName) {
    if (state.mode !== 'matrix') return { total: 0, done: 0, defect: 0, open: 0, pct: 0 };
    let total = 0, done = 0, defect = 0, open = 0;
    for (const sh of state.matrix.sheets) {
      const ann = state.annotations[sh.name] || {};
      for (const row of sh.rows) {
        const cell = row.cells[vehicleName];
        if (!cell || cell.disabled) continue;
        total++;
        const a = (ann[row.rowIdx] && ann[row.rowIdx][vehicleName]) || { status: 'open' };
        if (a.status === 'done') done++;
        else if (a.status === 'defect') defect++;
        else open++;
      }
    }
    const pct = total === 0 ? 0 : Math.round((done + defect) / total * 100);
    return { total, done, defect, open, pct };
  }

  function computeSheetVehicleStats(sheetName, vehicleName) {
    if (state.mode !== 'matrix') return { total: 0, done: 0, defect: 0, open: 0, pct: 0 };
    const ann = state.annotations[sheetName] || {};
    let total = 0, done = 0, defect = 0, open = 0;
    for (const row of getRelevantRows(sheetName, vehicleName)) {
      total++;
      const a = (ann[row.rowIdx] && ann[row.rowIdx][vehicleName]) || { status: 'open' };
      if (a.status === 'done') done++;
      else if (a.status === 'defect') defect++;
      else open++;
    }
    const pct = total === 0 ? 0 : Math.round((done + defect) / total * 100);
    return { total, done, defect, open, pct };
  }

  function computeOverallStats() {
    let total = 0, done = 0, defect = 0, open = 0;
    if (state.mode === 'matrix' && state.matrix) {
      for (const v of state.matrix.vehicles) {
        const s = computeVehicleStats(v.name);
        total += s.total; done += s.done; defect += s.defect; open += s.open;
      }
    }
    const pct = total === 0 ? 0 : Math.round((done + defect) / total * 100);
    return { total, done, defect, open, pct };
  }

  function isVehicleCompleted(vehicleName) {
    const s = computeVehicleStats(vehicleName);
    if (s.total === 0) return false;
    return (s.done + s.defect) / s.total >= COMPLETED_THRESHOLD;
  }

  /* ============================================================
     Navigation
     ============================================================ */
  function navigateTo(name, push = true) {
    if (push && state.screen && state.screen !== name) {
      state.screenStack.push(state.screen);
    }
    state.screen = name;
    for (const k in els.screens) {
      els.screens[k].classList.toggle('active', k === name);
    }
    updateHeader();
    els.backBtn.hidden = state.screen === 'start';

    if (name === 'vehicles') {
      // Beim Zurück zur Fahrzeugauswahl Sub-Fahrzeuge resetten
      state.subVehicles = [];
      state.pendingApplySubs.clear();
      state.currentVehicle = null;
      renderVehicles();
    }
    else if (name === 'sheets') renderSheets();
    else if (name === 'items') initWizard();
    else if (name === 'sessions') renderSessions();
    else if (name === 'start') {
      els.progressContainer.hidden = true;
      checkResume();
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function navigateBack() {
    const prev = state.screenStack.pop() || 'start';
    navigateTo(prev, false);
  }
  function updateHeader() {
    if (state.screen === 'start') {
      els.headerEyebrow.textContent = 'PRÜFPROTOKOLL';
      els.headerTitle.textContent = 'Abnahme';
      els.progressContainer.hidden = true;
    } else if (state.screen === 'sessions') {
      els.headerEyebrow.textContent = 'VERWALTEN';
      els.headerTitle.textContent = 'Sitzungen';
      els.progressContainer.hidden = true;
    } else if (state.screen === 'vehicles') {
      els.headerEyebrow.textContent = 'DATEI';
      els.headerTitle.textContent = state.filename || 'Datei';
      renderProgress(computeOverallStats());
      els.progressContainer.hidden = false;
    } else if (state.screen === 'sheets') {
      const isMatrix = state.mode === 'matrix' && state.currentVehicle;
      els.headerEyebrow.textContent = isMatrix ? state.currentVehicle : 'DATEI';
      els.headerTitle.textContent = isMatrix ? `Kategorien` : (state.filename || 'Datei');
      const stats = isMatrix ? computeVehicleStats(state.currentVehicle) : { total: 0, done: 0, defect: 0, open: 0, pct: 0 };
      renderProgress(stats);
      els.progressContainer.hidden = false;
    } else if (state.screen === 'items') {
      if (state.mode === 'matrix' && state.currentVehicle) {
        const sh = state.matrix.sheets[state.currentSheetIdx];
        let eyebrow = state.currentVehicle;
        if (state.subVehicles.length) eyebrow += ` + ${state.subVehicles.length}`;
        els.headerEyebrow.textContent = eyebrow;
        els.headerTitle.textContent = sh ? sh.name : '–';
        renderProgress(sh ? computeSheetVehicleStats(sh.name, state.currentVehicle) : { total: 0, done: 0, defect: 0, open: 0, pct: 0 });
      } else {
        const sh = state.sheets[state.currentSheetIdx];
        els.headerEyebrow.textContent = state.filename || 'DATEI';
        els.headerTitle.textContent = sh ? sh.name : '–';
        renderProgress({ total: 0, done: 0, defect: 0, open: 0, pct: 0 });
      }
      els.progressContainer.hidden = false;
    }
  }
  function renderProgress(stats) {
    els.statDone.textContent = stats.done;
    els.statDefect.textContent = stats.defect;
    els.statOpen.textContent = stats.open;
    els.statPercent.textContent = stats.pct + '%';
    els.progressFill.style.width = stats.pct + '%';
  }

  /* ============================================================
     Render: Fahrzeug-Auswahl
     ============================================================ */
  function renderVehicles() {
    if (state.mode !== 'matrix') return;
    const m = state.matrix;
    els.vehiclesFilename.textContent = state.filename;

    const open = [], completed = [];
    for (const v of m.vehicles) {
      (isVehicleCompleted(v.name) ? completed : open).push(v);
    }
    els.vehiclesMeta.textContent = `${open.length} ${open.length === 1 ? 'Fahrzeug' : 'Fahrzeuge'} offen · ${completed.length} abgenommen`;

    // Hinweisbox oben (nur falls noch kein Master gewählt)
    let intro = els.vehicleList.parentElement.querySelector('.vehicles-intro');
    if (!intro) {
      intro = document.createElement('div');
      intro.className = 'vehicles-intro';
      intro.innerHTML = `
        <span class="info-label">SO GEHT'S</span>
        Tippe auf das Fahrzeug, das du gerade prüfst. Danach kannst du bis zu 3 weitere Fahrzeuge dazu wählen — Eingaben kannst du dann pro Position auf diese mit übernehmen.
      `;
      els.vehicleList.parentElement.insertBefore(intro, els.vehicleList);
    }

    els.vehicleList.innerHTML = '';
    for (const v of open) els.vehicleList.appendChild(buildVehicleCard(v));

    els.completedList.innerHTML = '';
    for (const v of completed) {
      const c = buildVehicleCard(v);
      c.classList.add('completed');
      els.completedList.appendChild(c);
    }
    els.completedSummary.textContent = `${completed.length} abgenommene Fahrzeug${completed.length === 1 ? '' : 'e'} anzeigen`;
    els.completedSection.hidden = completed.length === 0;
  }

  function buildVehicleCard(v) {
    const stats = computeVehicleStats(v.name);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'vehicle-card';
    if (stats.defect > 0) card.classList.add('has-defect');

    const numMatch = v.name.match(/(\d+)$/);
    const prefix = v.name.replace(/\s*\d+$/, '').trim();
    const num = numMatch ? numMatch[1] : v.name;
    const badge = stats.defect > 0 ? `<span class="badge-defect">${stats.defect} ${stats.defect === 1 ? 'Mangel' : 'Mängel'}</span>` : '';

    // Kennzeichen mit Hintergrundfarbe als Haupt-Titel, FgNr darunter
    const kennzColor = v.kennzColor || '';
    const kennzStyle = kennzColor
      ? `style="background:${kennzColor}; color:${pickContrastColor(kennzColor)}; border-color:${kennzColor};"`
      : '';
    // Im Titel: Kennzeichen (falls vorhanden), sonst Fahrzeugname als Fallback
    const titleHtml = v.kennz
      ? `<span class="kennz-tag" ${kennzStyle}>${escapeHtml(v.kennz)}</span>`
      : escapeHtml(v.name);
    const fgnrHtml = v.fgnr ? `<span class="fgnr-tag">${escapeHtml(v.fgnr)}</span>` : '';

    card.innerHTML = `
      <div class="v-mark"><span>${escapeHtml(prefix || '·')}</span><span class="v-mark-num">${escapeHtml(num)}</span></div>
      <div class="v-info">
        <div class="v-name">${titleHtml} ${badge}</div>
        ${fgnrHtml ? `<div class="v-meta-tags">${fgnrHtml}</div>` : ''}
        <div class="v-progress">
          <div class="mini-bar"><div class="mini-fill" style="width:${stats.pct}%"></div></div>
          <div class="v-percent">${stats.pct}%</div>
        </div>
      </div>
      <div class="v-arrow">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </div>
    `;
    card.addEventListener('click', () => openMasterSubSelection(v));
    return card;
  }

  // Kontrastfarbe für Text auf farbigem Hintergrund (Schwarz oder Weiß)
  function pickContrastColor(hex) {
    const h = hex.replace('#', '');
    if (h.length !== 6) return '#000';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    // YIQ-Formel
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 140 ? '#0f141a' : '#ffffff';
  }

  // Nach Klick auf ein Fahrzeug: Modal zur Sub-Fahrzeug-Auswahl
  function openMasterSubSelection(masterVehicle) {
    const others = state.matrix.vehicles.filter(x =>
      x.name !== masterVehicle.name && !isVehicleCompleted(x.name)
    );
    state.subVehicles = []; // Reset bei jeder neuen Auswahl
    state.pendingApplySubs.clear();

    const card = els.modal.querySelector('.modal-card');
    let extra = card.querySelector('.modal-extra');
    if (extra) extra.remove();
    extra = document.createElement('div');
    extra.className = 'modal-extra';

    const masterKennzStyle = masterVehicle.kennzColor
      ? `style="background:${masterVehicle.kennzColor}; color:${pickContrastColor(masterVehicle.kennzColor)}; border-color:${masterVehicle.kennzColor};"`
      : '';

    extra.innerHTML = `
      <div class="master-summary">
        <div class="master-summary-label">Hauptfahrzeug</div>
        <div class="master-summary-name">${escapeHtml(masterVehicle.name)}
          ${masterVehicle.kennz ? `<span class="kennz-tag" ${masterKennzStyle}>${escapeHtml(masterVehicle.kennz)}</span>` : ''}
        </div>
      </div>
      <div class="sub-section-label">Optional: weitere Fahrzeuge zur gemeinsamen Bearbeitung (max. 3)</div>
      <div class="sub-vehicle-grid" id="subVehicleGrid"></div>
    `;
    card.insertBefore(extra, card.querySelector('.modal-actions'));

    const grid = extra.querySelector('#subVehicleGrid');
    if (!others.length) {
      grid.innerHTML = '<div class="empty-state" style="padding:16px 0;"><p>Keine weiteren Fahrzeuge verfügbar.</p></div>';
    } else {
      for (const v of others) {
        const stats = computeVehicleStats(v.name);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sub-vehicle-chip';
        btn.dataset.name = v.name;
        // Fortschritts-Hintergrund als linearer Verlauf (grün bis zur Prozentmarke, dann transparent)
        if (stats.pct > 0) {
          btn.style.background = `linear-gradient(90deg, var(--status-done-bg) 0%, var(--status-done-bg) ${stats.pct}%, var(--bg-elevated) ${stats.pct}%, var(--bg-elevated) 100%)`;
        }
        const kStyle = v.kennzColor
          ? `style="background:${v.kennzColor}; color:${pickContrastColor(v.kennzColor)}; border-color:${v.kennzColor};"`
          : '';
        btn.innerHTML = `
          <span class="sv-name">${escapeHtml(v.name)}</span>
          ${v.kennz ? `<span class="kennz-tag kennz-tag-small" ${kStyle}>${escapeHtml(v.kennz)}</span>` : ''}
          <span class="sv-stats">${stats.pct}%</span>
        `;
        btn.addEventListener('click', () => {
          const idx = state.subVehicles.indexOf(v.name);
          if (idx >= 0) {
            state.subVehicles.splice(idx, 1);
            btn.classList.remove('selected');
          } else {
            if (state.subVehicles.length >= 3) {
              toast('Maximal 3 weitere Fahrzeuge.', 'error');
              return;
            }
            state.subVehicles.push(v.name);
            btn.classList.add('selected');
          }
          updateSubCounter();
        });
        grid.appendChild(btn);
      }
    }
    const counter = document.createElement('div');
    counter.className = 'sub-counter';
    counter.id = 'subCounter';
    counter.textContent = '0 von 3 weiteren Fahrzeugen ausgewählt';
    extra.appendChild(counter);

    // Modal-Texte
    els.modalTitle.textContent = 'Fahrzeug-Auswahl';
    els.modalText.textContent = '';
    els.modalCancel.textContent = 'Abbrechen';
    els.modalOk.textContent = 'Prüfung starten';
    els.modalOk.style.display = '';

    els.modal.hidden = false;

    _modalOkCallback = () => {
      state.currentVehicle = masterVehicle.name;
      navigateTo('sheets');
    };
    _modalCloseCallback = () => {
      const e = card.querySelector('.modal-extra');
      if (e) e.remove();
      els.modalOk.textContent = 'OK';
    };
  }

  function updateSubCounter() {
    const c = document.getElementById('subCounter');
    if (!c) return;
    const n = state.subVehicles.length;
    c.textContent = `${n} von 3 weiteren Fahrzeugen ausgewählt`;
    c.classList.toggle('has-selection', n > 0);
  }

  /* ============================================================
     Render: Kategorie-Liste (pro Fahrzeug)
     ============================================================ */
  function renderSheets() {
    if (state.mode !== 'matrix' || !state.currentVehicle) {
      els.filenameTitle.textContent = state.filename;
      els.filenameMeta.textContent = '';
      els.sheetList.innerHTML = '<div class="empty-state"><p>Bitte zuerst ein Fahrzeug wählen.</p></div>';
      return;
    }
    const v = state.matrix.vehicles.find(x => x.name === state.currentVehicle);
    els.filenameTitle.textContent = state.currentVehicle;
    const meta = [v && v.fgnr, v && v.kennz].filter(Boolean).join(' · ');
    els.filenameMeta.textContent = meta || `${state.matrix.sheets.length} Kategorien`;

    els.sheetList.innerHTML = '';
    state.matrix.sheets.forEach((sh, idx) => {
      const stats = computeSheetVehicleStats(sh.name, state.currentVehicle);
      if (stats.total === 0) return;
      const card = document.createElement('button');
      card.className = 'sheet-card';
      card.type = 'button';
      const numMatch = sh.name.match(/^(\d+)\s+(.+)$/);
      const numBadge = numMatch ? numMatch[1] : '';
      const cleanName = numMatch ? numMatch[2] : sh.name;
      const defectBadge = stats.defect > 0 ? `<span class="badge-defect">${stats.defect} ${stats.defect === 1 ? 'Mangel' : 'Mängel'}</span>` : '';
      card.innerHTML = `
        ${numBadge ? `<div class="sheet-num-badge">${escapeHtml(numBadge)}</div>` : ''}
        <div class="sheet-info">
          <div class="sheet-name">${escapeHtml(cleanName)}</div>
          <div class="sheet-meta">${stats.total} Prüfpunkte · ${stats.done} erledigt${defectBadge}</div>
          <div class="sheet-progress">
            <div class="mini-bar"><div class="mini-fill" style="width:${stats.pct}%"></div></div>
            <div class="sheet-percent">${stats.pct}%</div>
          </div>
        </div>
        <div class="sheet-arrow">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </div>
      `;
      card.addEventListener('click', () => {
        state.currentSheetIdx = idx;
        state.currentItemIdx = 0;
        navigateTo('items');
      });
      els.sheetList.appendChild(card);
    });
  }

  /* ============================================================
     Wizard: Eine Position pro Seite
     ============================================================ */
  function initWizard() {
    if (state.mode !== 'matrix' || !state.currentVehicle) return;
    rebuildVisibleItems();
    // Wenn Index außerhalb, auf 0 zurücksetzen
    if (state.currentItemIdx >= state.visibleItems.length) state.currentItemIdx = 0;
    // Springe zur ersten offenen Position falls möglich
    if (state.currentItemIdx === 0) {
      const sh = state.matrix.sheets[state.currentSheetIdx];
      const ann = state.annotations[sh.name] || {};
      const firstOpen = state.visibleItems.findIndex(row => {
        const a = (ann[row.rowIdx] && ann[row.rowIdx][state.currentVehicle]) || { status: 'open' };
        return a.status === 'open';
      });
      if (firstOpen >= 0) state.currentItemIdx = firstOpen;
    }
    renderWizard();
  }

  function rebuildVisibleItems() {
    const sh = state.matrix.sheets[state.currentSheetIdx];
    if (!sh) { state.visibleItems = []; return; }
    state.visibleItems = getRelevantRows(sh.name, state.currentVehicle);
  }

  function renderWizard() {
    const sh = state.matrix.sheets[state.currentSheetIdx];
    const v = state.currentVehicle;
    if (!sh || !v) return;

    const total = state.visibleItems.length;
    if (total === 0) {
      els.wizCard.hidden = true;
      els.wizEmpty.hidden = false;
      els.wizPos.textContent = '0';
      els.wizTotal.textContent = '0';
      els.wizContext.textContent = '';
      els.wizPrev.disabled = true;
      els.wizNext.disabled = true;
      els.wizProgressFill.style.width = '0%';
      return;
    }
    els.wizCard.hidden = false;
    els.wizEmpty.hidden = true;

    if (state.currentItemIdx < 0) state.currentItemIdx = 0;
    if (state.currentItemIdx >= total) state.currentItemIdx = total - 1;

    const row = state.visibleItems[state.currentItemIdx];
    const ann = getAnnotation(sh.name, row.rowIdx, v);
    const cell = row.cells[v];
    const origValue = (cell && cell.value) || '';

    // Zähler & Kontext
    els.wizPos.textContent = String(state.currentItemIdx + 1);
    els.wizTotal.textContent = String(total);
    const contextParts = [];
    if (row.section) contextParts.push(row.section);
    els.wizContext.textContent = contextParts.join(' · ');

    // Fortschritt (auf Sheet-Ebene für dieses Fahrzeug)
    const stats = computeSheetVehicleStats(sh.name, v);
    els.wizProgressFill.style.width = stats.pct + '%';

    // Karte aufbauen
    els.wizCard.dataset.status = ann.status;
    els.wizCard.dataset.rowIdx = row.rowIdx;

    const metaPills = [];
    if (row.pos) metaPills.push(`<span class="wm-pos">Pos. ${escapeHtml(row.pos)}</span>`);
    if (row.anz) metaPills.push(`<span>×${escapeHtml(row.anz)}</span>`);
    if (row.beistell) metaPills.push(`<span>Beistell ${escapeHtml(row.beistell)}</span>`);
    if (row.lagerort) metaPills.push(`<span>${escapeHtml(row.lagerort)}</span>`);

    // Vor-Notiz aus Baubesprechung (nicht editierbar)
    const baubesprechungHtml = row.baubesprechung
      ? `<div class="wizard-info"><span class="info-label">Notiz Baubesprechung</span>${escapeHtml(row.baubesprechung)}</div>`
      : '';

    // Original-Excel-Wert (falls bereits ein Wert in der Datei stand) als Info
    // Original-Excel-Wert nur anzeigen, wenn er NICHT bereits als Annotation übernommen wurde
    // (sonst wäre es eine redundante Anzeige des gleichen Inhalts).
    const showOrig = origValue && !ann.fromFile && ann.status === 'open' && !ann.note;
    const origHtml = showOrig
      ? `<div class="wizard-prev-value"><span class="info-label">Bestehender Eintrag in Datei</span>${escapeHtml(origValue)}</div>`
      : '';

    // Mängel-Notizfeld nur sichtbar, wenn Status = Mangel oder bereits Notiz vorhanden
    const showNote = ann.status === 'defect' || (ann.note && ann.note.trim() !== '');
    const noteHtml = `
      <div class="wizard-note" id="wizNoteWrap" ${showNote ? '' : 'hidden'}>
        <div class="note-label">
          <span class="dot-defect" style="width:6px;height:6px;border-radius:50%;background:var(--status-defect);display:inline-block;"></span>
          Mangel beschreiben
        </div>
        <textarea class="note-input" id="wizNoteInput" rows="3" placeholder="Was ist nicht in Ordnung an ${escapeHtml(state.currentVehicle)}?" autocapitalize="sentences" autocomplete="off">${escapeHtml(ann.note || '')}</textarea>
      </div>
    `;

    // Übernehmen-Bereich für Sub-Fahrzeuge: Markierung — bei Status-Klick werden markierte Subs synchronisiert
    let applyHtml = '';
    if (state.subVehicles.length) {
      const chips = state.subVehicles.map(subName => {
        const subVeh = state.matrix.vehicles.find(x => x.name === subName);
        const subCell = row.cells[subName];
        const isAvailable = subCell && !subCell.disabled;
        const subAnn = getAnnotation(sh.name, row.rowIdx, subName);
        const masterHasValue = ann.status === 'done' || ann.status === 'defect';
        const isSynced = masterHasValue && subAnn.status === ann.status && (subAnn.note || '') === (ann.note || '');
        const isMarked = state.pendingApplySubs.has(subName);
        const kStyle = subVeh && subVeh.kennzColor
          ? `style="background:${subVeh.kennzColor}; color:${pickContrastColor(subVeh.kennzColor)}; border-color:${subVeh.kennzColor};"`
          : '';
        let stateClass = '';
        let labelTxt;
        if (!isAvailable) {
          stateClass = 'unavailable';
          labelTxt = 'nicht relevant';
        } else if (isMarked) {
          stateClass = 'marked';
          labelTxt = 'wird übernommen';
        } else if (isSynced) {
          stateClass = 'matched';
          labelTxt = 'übernommen';
        } else {
          labelTxt = 'auch übernehmen';
        }
        return `
          <button type="button" class="apply-chip ${stateClass}" data-sub="${escapeHtml(subName)}" ${!isAvailable ? 'disabled' : ''}>
            <span class="ac-name">${escapeHtml(subName)}</span>
            ${subVeh && subVeh.kennz ? `<span class="kennz-tag kennz-tag-small" ${kStyle}>${escapeHtml(subVeh.kennz)}</span>` : ''}
            <span class="ac-state">${labelTxt}</span>
          </button>
        `;
      }).join('');
      applyHtml = `
        <div class="apply-section">
          <div class="apply-label">Status auch auf folgende Fahrzeuge übernehmen</div>
          <div class="apply-grid">${chips}</div>
        </div>
      `;
    }

    els.wizCard.innerHTML = `
      <div class="wizard-meta">
        ${metaPills.map(p => p).join('<span class="wm-sep">·</span>')}
      </div>
      <h3 class="wizard-title">${escapeHtml(row.titel)}</h3>
      ${baubesprechungHtml}
      ${origHtml}
      <div class="wizard-status-row" role="group" aria-label="Status">
        <button type="button" class="status-btn ${ann.status === 'open' ? 'active' : ''}" data-status="open">
          Offen<span class="check">${checkSvg()}</span>
        </button>
        <button type="button" class="status-btn ${ann.status === 'done' ? 'active' : ''}" data-status="done">
          Erledigt<span class="check">${checkSvg()}</span>
        </button>
        <button type="button" class="status-btn ${ann.status === 'defect' ? 'active' : ''}" data-status="defect">
          Mangel<span class="check">${checkSvg()}</span>
        </button>
      </div>
      ${noteHtml}
      ${applyHtml}
    `;

    // Status-Buttons
    els.wizCard.querySelectorAll('.status-btn').forEach(btn => {
      btn.addEventListener('click', () => onStatusClick(btn.dataset.status));
    });
    // Note-Input
    const ta = els.wizCard.querySelector('#wizNoteInput');
    if (ta) {
      autoresizeNote(ta);
      ta.addEventListener('input', () => {
        autoresizeNote(ta);
        setAnnotation(sh.name, row.rowIdx, { note: ta.value }, v);
        // Subs, die bereits synchron sind, bei Notiz-Änderungen mitziehen
        syncMatchedSubs();
        injectApplySection();
      });
    }
    // Übernehmen-Buttons
    els.wizCard.querySelectorAll('.apply-chip').forEach(chip => {
      chip.addEventListener('click', () => onApplyClick(chip.dataset.sub));
    });

    // Navigation aktivieren
    els.wizPrev.disabled = state.currentItemIdx === 0;
    els.wizNext.disabled = state.currentItemIdx === total - 1;

    // Header aktualisieren (Stats können sich geändert haben)
    updateHeader();
  }

  function autoresizeNote(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }

  function checkSvg() {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"/></svg>`;
  }

  // Synchronisiert Subs, die bereits den Master-Status haben, mit der neuen Master-Notiz.
  // Wird beim Tippen im Notizfeld aufgerufen, damit übernommene Subs „mitwandern".
  function syncMatchedSubs() {
    const sh = state.matrix.sheets[state.currentSheetIdx];
    const v = state.currentVehicle;
    const row = state.visibleItems[state.currentItemIdx];
    if (!sh || !v || !row) return;
    const masterAnn = getAnnotation(sh.name, row.rowIdx, v);
    if (masterAnn.status !== 'done' && masterAnn.status !== 'defect') return;
    for (const subName of state.subVehicles) {
      const subCell = row.cells[subName];
      if (!subCell || subCell.disabled) continue;
      const subAnn = getAnnotation(sh.name, row.rowIdx, subName);
      if (subAnn.status === masterAnn.status) {
        // Notiz angleichen
        if ((subAnn.note || '') !== (masterAnn.note || '')) {
          setAnnotation(sh.name, row.rowIdx, { note: masterAnn.note || '' }, subName);
        }
      }
    }
  }

  // Toggle einer Sub-Markierung. Übernahme passiert beim nächsten Status-Klick im Master.
  function onApplyClick(subName) {
    const sh = state.matrix.sheets[state.currentSheetIdx];
    const row = state.visibleItems[state.currentItemIdx];
    if (!sh || !row) return;
    const subCell = row.cells[subName];
    if (!subCell || subCell.disabled) {
      toast('Position ist für ' + subName + ' nicht zu prüfen.', 'error');
      return;
    }
    if (state.pendingApplySubs.has(subName)) {
      state.pendingApplySubs.delete(subName);
    } else {
      state.pendingApplySubs.add(subName);
    }
    injectApplySection();
  }

  // Wendet die markierten Subs auf den aktuellen Master-Status an.
  // Returns Promise<true> wenn alles ok, Promise<false> wenn vom User abgebrochen.
  async function applyPendingSubs() {
    const sh = state.matrix.sheets[state.currentSheetIdx];
    const v = state.currentVehicle;
    const row = state.visibleItems[state.currentItemIdx];
    if (!sh || !v || !row) return true;
    if (state.pendingApplySubs.size === 0) return true;
    const masterAnn = getAnnotation(sh.name, row.rowIdx, v);
    if (masterAnn.status !== 'done' && masterAnn.status !== 'defect') return true;

    // Subs sammeln, die einen Konflikt haben (bereits anderer Wert)
    const conflicts = [];
    for (const subName of state.pendingApplySubs) {
      const subCell = row.cells[subName];
      if (!subCell || subCell.disabled) continue;
      const subAnn = getAnnotation(sh.name, row.rowIdx, subName);
      const isSame = subAnn.status === masterAnn.status && (subAnn.note || '') === (masterAnn.note || '');
      if (isSame) continue;
      if (subAnn.status !== 'open' || subAnn.note) conflicts.push({ subName, subAnn });
    }

    // Bei Konflikten einmal sammelfragen
    if (conflicts.length) {
      const masterText = masterAnn.status === 'done'
        ? (masterAnn.note ? `Erledigt — „${masterAnn.note}"` : 'Erledigt')
        : (masterAnn.note ? `Mangel — „${masterAnn.note}"` : 'Mangel');
      const lines = conflicts.map(c => {
        const a = c.subAnn;
        const t = a.status === 'done'
          ? (a.note ? `Erledigt — „${a.note}"` : 'Erledigt')
          : a.status === 'defect'
            ? (a.note ? `Mangel — „${a.note}"` : 'Mangel')
            : (a.note ? `Offen — „${a.note}"` : 'Offen');
        return `${c.subName}: ${t}`;
      }).join('\n');
      const ok = await confirmModal(
        `Bestehende Werte überschreiben?`,
        `Die folgenden Fahrzeuge haben bereits einen Eintrag:\n${lines}\n\nNeu wird gesetzt:\n${masterText}`
      );
      if (!ok) return false;
    }

    // Übernehmen
    for (const subName of state.pendingApplySubs) {
      const subCell = row.cells[subName];
      if (!subCell || subCell.disabled) continue;
      setAnnotation(sh.name, row.rowIdx, { status: masterAnn.status, note: masterAnn.note || '' }, subName);
    }
    return true;
  }

  // Übernehmen-Sektion nachträglich aufbauen oder aktualisieren (ohne komplettes Re-Rendern)
  function injectApplySection() {
    const sh = state.matrix.sheets[state.currentSheetIdx];
    const v = state.currentVehicle;
    const row = state.visibleItems[state.currentItemIdx];
    if (!sh || !v || !row) return;
    const ann = getAnnotation(sh.name, row.rowIdx, v);
    let section = els.wizCard.querySelector('.apply-section');
    if (!state.subVehicles.length) {
      if (section) section.remove();
      return;
    }
    if (!section) {
      section = document.createElement('div');
      section.className = 'apply-section';
      els.wizCard.appendChild(section);
    }
    const masterHasValue = ann.status === 'done' || ann.status === 'defect';
    const chips = state.subVehicles.map(subName => {
      const subVeh = state.matrix.vehicles.find(x => x.name === subName);
      const subCell = row.cells[subName];
      const isAvailable = subCell && !subCell.disabled;
      const subAnn = getAnnotation(sh.name, row.rowIdx, subName);
      const isSynced = masterHasValue && subAnn.status === ann.status && (subAnn.note || '') === (ann.note || '');
      const isMarked = state.pendingApplySubs.has(subName);
      const kStyle = subVeh && subVeh.kennzColor
        ? `style="background:${subVeh.kennzColor}; color:${pickContrastColor(subVeh.kennzColor)}; border-color:${subVeh.kennzColor};"`
        : '';
      let stateClass = '';
      let labelTxt;
      if (!isAvailable) {
        stateClass = 'unavailable';
        labelTxt = 'nicht relevant';
      } else if (isMarked) {
        stateClass = 'marked';
        labelTxt = 'wird übernommen';
      } else if (isSynced) {
        stateClass = 'matched';
        labelTxt = 'übernommen';
      } else {
        labelTxt = 'auch übernehmen';
      }
      return `
        <button type="button" class="apply-chip ${stateClass}" data-sub="${escapeHtml(subName)}" ${!isAvailable ? 'disabled' : ''}>
          <span class="ac-name">${escapeHtml(subName)}</span>
          ${subVeh && subVeh.kennz ? `<span class="kennz-tag kennz-tag-small" ${kStyle}>${escapeHtml(subVeh.kennz)}</span>` : ''}
          <span class="ac-state">${labelTxt}</span>
        </button>
      `;
    }).join('');
    section.innerHTML = `
      <div class="apply-label">Status auch auf folgende Fahrzeuge übernehmen</div>
      <div class="apply-grid">${chips}</div>
    `;
    section.querySelectorAll('.apply-chip').forEach(chip => {
      chip.addEventListener('click', () => onApplyClick(chip.dataset.sub));
    });
  }

  async function onStatusClick(newStatus) {
    const sh = state.matrix.sheets[state.currentSheetIdx];
    const v = state.currentVehicle;
    const row = state.visibleItems[state.currentItemIdx];
    if (!row) return;
    const cur = getAnnotation(sh.name, row.rowIdx, v);
    const statusChanged = cur.status !== newStatus;
    if (statusChanged) {
      setAnnotation(sh.name, row.rowIdx, { status: newStatus }, v);
      // Bestätigungston nur bei tatsächlicher Änderung
      if (newStatus === 'done') playDoneSound();
      else if (newStatus === 'defect') playDefectSound();
    }
    // UI sofort anpassen
    els.wizCard.dataset.status = newStatus;
    els.wizCard.querySelectorAll('.status-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.status === newStatus);
    });
    const noteWrap = els.wizCard.querySelector('#wizNoteWrap');
    const noteInput = els.wizCard.querySelector('#wizNoteInput');
    if (noteWrap) {
      const showNote = newStatus === 'defect' || (noteInput && noteInput.value.trim() !== '');
      noteWrap.hidden = !showNote;
    }

    // Wenn Master einen Wert hat (done/defect) und es Markierungen gibt: jetzt übernehmen
    let appliedCount = 0;
    if ((newStatus === 'done' || newStatus === 'defect') && state.pendingApplySubs.size > 0) {
      const ok = await applyPendingSubs();
      if (!ok) {
        // User hat abgebrochen → trotzdem Sub-Liste leeren? Nein, Markierungen bleiben.
        // Apply-Section neu rendern, damit „übernommen"-Status sichtbar wird falls einige Subs schon passten
        injectApplySection();
        updateHeader();
        return;
      }
      appliedCount = state.pendingApplySubs.size;
      // Markierungen für diese Position löschen (da übernommen)
      state.pendingApplySubs.clear();
    }

    if (newStatus === 'defect' && noteInput) {
      setTimeout(() => { noteInput.focus(); }, 50);
      injectApplySection();
    } else if (newStatus === 'open') {
      injectApplySection();
    } else if (newStatus === 'done') {
      // Auto-Weiter — auch nach Übernahme an markierte Subs
      if (appliedCount > 0) toast(`Auf ${appliedCount} weitere übernommen`);
      setTimeout(() => {
        if (state.currentItemIdx < state.visibleItems.length - 1) {
          state.pendingApplySubs.clear();
          state.currentItemIdx++;
          renderWizard();
        } else {
          updateHeader();
          els.wizPrev.disabled = false;
          els.wizNext.disabled = true;
        }
      }, 280);
    }

    updateHeader();
    const stats = computeSheetVehicleStats(sh.name, v);
    els.wizProgressFill.style.width = stats.pct + '%';
  }

  function wizardPrev() {
    if (state.currentItemIdx > 0) {
      state.pendingApplySubs.clear();
      state.currentItemIdx--;
      renderWizard();
    }
  }
  function wizardNext() {
    if (state.currentItemIdx < state.visibleItems.length - 1) {
      state.pendingApplySubs.clear();
      state.currentItemIdx++;
      renderWizard();
    }
  }

  /* ----- Übersicht-Modal ----- */
  function showOverview() {
    if (state.mode !== 'matrix' || !state.currentVehicle) return;
    const sh = state.matrix.sheets[state.currentSheetIdx];
    const v = state.currentVehicle;
    const ann = state.annotations[sh.name] || {};

    const items = state.visibleItems.map((row, idx) => {
      const a = (ann[row.rowIdx] && ann[row.rowIdx][v]) || { status: 'open' };
      return { idx, row, status: a.status };
    });

    const stats = computeSheetVehicleStats(sh.name, v);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-height: 60vh; overflow-y: auto; -webkit-overflow-scrolling: touch; margin-bottom: 12px;';
    const filterRow = document.createElement('div');
    filterRow.className = 'overview-filter';
    filterRow.innerHTML = `
      <button class="chip ${state.wizardFilter==='all'?'active':''}" data-f="all">Alle ${stats.total}</button>
      <button class="chip ${state.wizardFilter==='open'?'active':''}" data-f="open">Offen ${stats.open}</button>
      <button class="chip ${state.wizardFilter==='done'?'active':''}" data-f="done">iO ${stats.done}</button>
      <button class="chip chip-defect ${state.wizardFilter==='defect'?'active':''}" data-f="defect">Mängel ${stats.defect}</button>
    `;

    const list = document.createElement('div');
    list.className = 'overview-list';
    function renderList() {
      const filtered = items.filter(it => state.wizardFilter === 'all' || it.status === state.wizardFilter);
      if (!filtered.length) {
        list.innerHTML = '<div class="empty-state" style="padding: 24px 0;"><p>Keine Einträge.</p></div>';
        return;
      }
      list.innerHTML = '';
      for (const it of filtered) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'overview-item' + (it.idx === state.currentItemIdx ? ' current' : '');
        btn.innerHTML = `
          <span class="ov-pos">${escapeHtml(it.row.pos || '·')}</span>
          <span class="ov-title">${escapeHtml(it.row.titel)}</span>
          <span class="ov-status ${it.status}"></span>
        `;
        btn.addEventListener('click', () => {
          state.pendingApplySubs.clear();
          state.currentItemIdx = it.idx;
          closeModal();
          renderWizard();
        });
        list.appendChild(btn);
      }
    }
    renderList();

    filterRow.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        state.wizardFilter = chip.dataset.f;
        filterRow.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
        renderList();
      });
    });

    wrap.appendChild(filterRow);
    wrap.appendChild(list);

    // Modal mit benutzerdefiniertem Inhalt zeigen
    els.modalTitle.textContent = `${sh.name} · ${v}`;
    els.modalText.textContent = `${stats.total} prüfbare Punkte`;
    // Body austauschen: alten Body löschen und unseren wrap einfügen
    const card = els.modal.querySelector('.modal-card');
    let extra = card.querySelector('.modal-extra');
    if (extra) extra.remove();
    extra = document.createElement('div');
    extra.className = 'modal-extra';
    extra.appendChild(wrap);
    card.insertBefore(extra, card.querySelector('.modal-actions'));
    els.modalCancel.textContent = 'Schließen';
    els.modalOk.style.display = 'none';
    els.modal.hidden = false;
    _modalCloseCallback = () => {
      const e = card.querySelector('.modal-extra');
      if (e) e.remove();
      els.modalCancel.textContent = 'Abbrechen';
      els.modalOk.style.display = '';
    };
  }

  /* ============================================================
     Sitzungsverwaltung
     ============================================================ */
  async function renderSessions() {
    const all = await idbAll();
    els.sessionList.innerHTML = '';
    if (!all.length) { els.sessionEmpty.hidden = false; return; }
    els.sessionEmpty.hidden = true;
    for (const rec of all) {
      const stats = rec.stats || { total: 0, done: 0, defect: 0, pct: 0 };
      const card = document.createElement('div');
      card.className = 'sheet-card';
      card.style.cursor = 'default';
      card.innerHTML = `
        <div class="sheet-info">
          <div class="sheet-name">${escapeHtml(rec.filename)}</div>
          <div class="sheet-meta">${stats.total} Punkte · ${stats.done} iO · ${stats.defect} Mängel · ${formatDateTime(rec.modifiedAt || rec.createdAt)}</div>
          <div class="sheet-progress">
            <div class="mini-bar"><div class="mini-fill" style="width:${stats.pct || 0}%"></div></div>
            <div class="sheet-percent">${stats.pct || 0}%</div>
          </div>
        </div>
      `;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex; flex-direction: column; gap: 6px; flex: 0 0 auto;';
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-tertiary btn-compact';
      openBtn.style.cssText = 'min-height: 40px; padding: 8px 12px;';
      openBtn.textContent = 'Öffnen';
      openBtn.addEventListener('click', () => loadSession(rec));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-tertiary btn-compact';
      delBtn.style.cssText = 'min-height: 40px; padding: 8px 12px; color: var(--accent);';
      delBtn.textContent = 'Löschen';
      delBtn.addEventListener('click', async () => {
        const ok = await confirmModal('Sitzung löschen?', `„${rec.filename}" wird unwiderruflich entfernt.`);
        if (!ok) return;
        await idbDelete(rec.id);
        if (state.sessionId === rec.id) {
          state.sessionId = null;
          try { localStorage.removeItem(LS_LAST); } catch (_) {}
        }
        renderSessions();
        toast('Sitzung gelöscht');
      });
      actions.appendChild(openBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
      els.sessionList.appendChild(card);
    }
  }

  /* ============================================================
     Export
     ============================================================ */
  /* ============================================================
     Export: ZIP byte-genau patchen statt komplett neu schreiben
     ============================================================
     Wir öffnen das Original-XLSX-ZIP, modifizieren nur die XML-
     Strings der betroffenen Zellen direkt und schreiben das ZIP
     wieder zurück. So bleiben Makros, Stylings, Hyperlinks,
     Validierungen etc. unverändert.
     ============================================================ */

  // Workbook.xml lesen, um Sheet-Name → sheetN.xml-Datei zu mappen
  function parseWorkbookRels(xmlStr) {
    // sheet-Elemente: <sheet name="..." sheetId=".." r:id="rId1"/>
    // Sheet-Namen können XML-Escapes enthalten (z.B. "03 Beladung &amp; Lagerung"),
    // die wir wieder dekodieren müssen, damit der Vergleich mit state.matrix.sheets passt.
    const sheets = {};
    const sheetRe = /<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g;
    let m;
    while ((m = sheetRe.exec(xmlStr))) {
      const name = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      sheets[name] = m[2];
    }
    return sheets;
  }
  function parseRelationships(xmlStr) {
    // Relationship Id="rId1" Target="worksheets/sheet1.xml"
    const map = {};
    const relRe = /<Relationship\s+Id="([^"]+)"\s+[^>]*Target="([^"]+)"/g;
    let m;
    while ((m = relRe.exec(xmlStr))) {
      map[m[1]] = m[2];
    }
    return map;
  }

  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // Aus dem Inline-Sharedstrings-Format konvertieren: <c r="A1"...><v>...</v></c> →  inline string
  // Wir schreiben Zellen IMMER mit t="inlineStr" und <is><t>...</t></is>, damit wir
  // keinen sharedStrings-Index berechnen müssen. Das ist gültiges XLSX.
  function buildInlineStringCellXml(ref, styleIdx, value) {
    const sAttr = styleIdx ? ` s="${styleIdx}"` : '';
    const v = value == null ? '' : String(value);
    // <t xml:space="preserve"> für Werte mit Leerzeichen am Anfang/Ende
    const preserve = /^\s|\s$/.test(v) ? ' xml:space="preserve"' : '';
    return `<c r="${ref}"${sAttr} t="inlineStr"><is><t${preserve}>${xmlEscape(v)}</t></is></c>`;
  }

  // Spalten-Index (0-basiert) zu Excel-Buchstaben (A, B, …, Z, AA, …)
  function colNumToLetters(n) {
    let s = '';
    n = n + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // Modifiziert eine sheetN.xml so, dass die angegebenen Zellen ersetzt werden.
  // edits: Map<ref, newValue>   z.B. "F10" → "iO"
  // Strategie: row-für-row durchgehen, in jeder <row>-Tag-Sequenz die betroffenen
  // <c r="..."/>-Zellen ersetzen; nicht-existierende Zellen am Ende der row einfügen.
  function patchSheetXml(xml, edits) {
    if (!edits || Object.keys(edits).length === 0) return xml;

    // Edits nach Zeilennummer gruppieren
    const editsByRow = new Map();
    for (const ref in edits) {
      const m = ref.match(/^([A-Z]+)(\d+)$/);
      if (!m) continue;
      const rowNum = parseInt(m[2], 10);
      if (!editsByRow.has(rowNum)) editsByRow.set(rowNum, {});
      editsByRow.get(rowNum)[ref] = edits[ref];
    }

    // Wir gehen über die <row r="N">...</row>-Blöcke. Für jede betroffene Zeile
    // ersetzen oder fügen wir Zellen ein.
    return xml.replace(/<row\s([^>]*)>([\s\S]*?)<\/row>/g, function (match, attrs, content) {
      // Zeilennummer aus attrs lesen (r="N")
      const rAttr = attrs.match(/\br="(\d+)"/);
      if (!rAttr) return match;
      const rowNum = parseInt(rAttr[1], 10);
      const rowEdits = editsByRow.get(rowNum);
      if (!rowEdits) return match;

      // Bestehende Zellen ersetzen.
      // Wichtig: Attribute dürfen kein '/' enthalten, damit `<c r="E10" s="43"/>`
      // sauber als self-closing erkannt wird und nicht versehentlich mit dem
      // nächsten <c>-Tag zusammengezogen wird.
      let newContent = content;
      const handled = new Set();
      newContent = newContent.replace(/<c\s([^>\/]*?)(\/>|>[\s\S]*?<\/c>)/g, function (cellMatch, cellAttrs) {
        const refMatch = cellAttrs.match(/\br="([^"]+)"/);
        if (!refMatch) return cellMatch;
        const ref = refMatch[1];
        if (!(ref in rowEdits)) return cellMatch;
        handled.add(ref);
        // Style-Index aus dem Original übernehmen falls vorhanden
        const sMatch = cellAttrs.match(/\bs="(\d+)"/);
        const styleIdx = sMatch ? parseInt(sMatch[1], 10) : 0;
        return buildInlineStringCellXml(ref, styleIdx, rowEdits[ref]);
      });

      // Neue Zellen am Ende einfügen, falls ref noch nicht da war
      const toAdd = [];
      for (const ref in rowEdits) {
        if (!handled.has(ref)) {
          toAdd.push(buildInlineStringCellXml(ref, 0, rowEdits[ref]));
        }
      }
      if (toAdd.length) {
        newContent = newContent + toAdd.join('');
      }
      return `<row ${attrs}>${newContent}</row>`;
    });
  }

  // Entfernt sämtliche Makro-Komponenten aus einem entpackten XLSX-ZIP, damit
  // die Datei beim Re-Packen als saubere .xlsx ohne Makros funktioniert.
  function stripMacros(zipped) {
    // 1. vbaProject.bin und alle ähnlichen Binärdateien löschen
    for (const key of Object.keys(zipped)) {
      if (/vbaProject\.bin$/i.test(key)) delete zipped[key];
      if (/vbaProjectSignature\.bin$/i.test(key)) delete zipped[key];
    }

    // 2. [Content_Types].xml bereinigen
    if (zipped['[Content_Types].xml']) {
      let ct = strFromU8(zipped['[Content_Types].xml']);
      // Workbook-Content-Type von macro-enabled auf normal umstellen
      ct = ct.replace(
        /application\/vnd\.ms-excel\.sheet\.macroEnabled\.main\+xml/g,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
      );
      // Komplette VBA-Override-Einträge entfernen
      ct = ct.replace(/<Override[^>]*ContentType="application\/vnd\.ms-office\.vbaProject"[^>]*\/>/g, '');
      ct = ct.replace(/<Default[^>]*ContentType="application\/vnd\.ms-office\.vbaProject"[^>]*\/>/g, '');
      zipped['[Content_Types].xml'] = strToU8(ct);
    }

    // 3. workbook.xml.rels: Relationship zu vbaProject entfernen
    if (zipped['xl/_rels/workbook.xml.rels']) {
      let rels = strFromU8(zipped['xl/_rels/workbook.xml.rels']);
      rels = rels.replace(/<Relationship[^>]*Type="[^"]*vbaProject"[^>]*\/>/g, '');
      zipped['xl/_rels/workbook.xml.rels'] = strToU8(rels);
    }

    // 4. workbook.xml: codeName-Attribute entfernen (sind nur für VBA relevant)
    if (zipped['xl/workbook.xml']) {
      let wb = strFromU8(zipped['xl/workbook.xml']);
      wb = wb.replace(/\s+codeName="[^"]*"/g, '');
      zipped['xl/workbook.xml'] = strToU8(wb);
    }

    // 5. Worksheets: codeName-Attribute in sheetPr entfernen
    for (const key of Object.keys(zipped)) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(key)) {
        let xml = strFromU8(zipped[key]);
        if (xml.indexOf('codeName') !== -1) {
          xml = xml.replace(/\s+codeName="[^"]*"/g, '');
          zipped[key] = strToU8(xml);
        }
      }
    }
  }

  function exportXlsx() {
    if (!state.fileBuffer) { toast('Keine Datei geladen.', 'error'); return; }
    if (typeof fflate === 'undefined') {
      toast('ZIP-Bibliothek nicht geladen.', 'error');
      return;
    }
    try {
      // Original-Bytes als Uint8Array
      const origBytes = new Uint8Array(state.fileBuffer);
      // ZIP entpacken
      const zipped = fflate.unzipSync(origBytes);

      // Workbook lesen: Sheet-Namen → rIds → Worksheet-Pfade
      const workbookXml = strFromU8(zipped['xl/workbook.xml']);
      const sheetNameToRid = parseWorkbookRels(workbookXml);
      const relsXml = strFromU8(zipped['xl/_rels/workbook.xml.rels']);
      const ridToTarget = parseRelationships(relsXml);

      // Edits sammeln: pro Worksheet-Datei eine Map ref → value
      const editsPerSheet = new Map(); // path → { ref: value }
      let totalEdits = 0;

      if (state.mode === 'matrix' && state.matrix) {
        for (const sh of state.matrix.sheets) {
          const rid = sheetNameToRid[sh.name];
          if (!rid) continue;
          const target = ridToTarget[rid];
          if (!target) continue;
          const sheetPath = target.startsWith('/')
            ? target.replace(/^\//, '')
            : 'xl/' + target;
          const ann = state.annotations[sh.name] || {};
          for (const row of sh.rows) {
            const rowAnn = ann[row.rowIdx] || {};
            for (const veh of state.matrix.vehicles) {
              const cellInfo = row.cells[veh.name];
              if (!cellInfo || cellInfo.disabled) continue;
              const a = rowAnn[veh.name];
              if (!a) continue;
              // Datei-Übernahmen ohne Änderung NICHT exportieren
              if (a.fromFile) continue;
              const newVal = formatExcelCellValue(a.status, a.note, '');
              // Excel-Referenz: Spaltenbuchstabe + Zeilennummer (1-basiert)
              const ref = colNumToLetters(veh.col) + (row.rowIdx + 1);
              if (!editsPerSheet.has(sheetPath)) editsPerSheet.set(sheetPath, {});
              editsPerSheet.get(sheetPath)[ref] = newVal;
              totalEdits++;
            }
          }
        }
      }

      if (totalEdits === 0) {
        toast('Keine Änderungen zum Exportieren.', 'error');
        return;
      }

      // Worksheets patchen
      for (const [path, edits] of editsPerSheet) {
        if (!zipped[path]) {
          console.warn('Worksheet nicht gefunden:', path);
          continue;
        }
        const origXml = strFromU8(zipped[path]);
        const newXml = patchSheetXml(origXml, edits);
        zipped[path] = strToU8(newXml);
      }

      // Vor dem Zippen alle Makro-Komponenten entfernen, damit immer eine saubere
      // .xlsx ohne Makros entsteht. Makros werden in der App nicht gebraucht und
      // Excel mag das xlsm-Format nur, wenn die Endung auch passt — also einfacher
      // weg damit.
      stripMacros(zipped);

      // ZIP wieder packen — Level 6 ist Standard, gute Balance
      const newBytes = fflate.zipSync(zipped, { level: 6 });

      // Immer als .xlsx exportieren (ohne Makros, siehe stripMacros oben).
      const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const blob = new Blob([newBytes], { type: mime });
      const filename = generateExportFilename('xlsx');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.type = mime;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);

      state.exported = true;
      flushSave();
      toast(`Exportiert: ${filename} (${totalEdits} Änderungen)`, 'success');

      // Nach kurzer Verzögerung Modal mit Upload-Vorschlag
      setTimeout(() => showUploadPrompt(filename), 800);
    } catch (err) {
      console.error(err);
      toast('Export fehlgeschlagen: ' + (err.message || err), 'error');
    }
  }

  function showUploadPrompt(filename) {
    const uploadUrl = getEboxLink('upload');
    if (!uploadUrl) return;
    const isXlsm = filename.toLowerCase().endsWith('.xlsm');
    const card = els.modal.querySelector('.modal-card');
    let extra = card.querySelector('.modal-extra');
    if (extra) extra.remove();
    extra = document.createElement('div');
    extra.className = 'modal-extra';
    // Bei xlsm-Dateien zusätzlich den Hinweis einblenden, dass die Endung wichtig ist
    const xlsmHint = isXlsm
      ? `<div style="background: #fff7e6; border: 1px solid #f0c060; border-radius: 8px; padding: 10px 12px; margin-top: 10px; font-size: 13px; line-height: 1.45; color: #6b4a00;">
          <strong>Wichtig:</strong> Die Datei muss die Endung <code>.xlsm</code> behalten. Falls Safari sie als <code>.xlsx</code> ablegt, in der Files-App auf die Datei lang tippen → Umbenennen → Endung auf <code>.xlsm</code> ändern. Excel zeigt sonst „Datei beschädigt".
        </div>`
      : '';
    extra.innerHTML = `
      <div style="background: var(--bg); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px;">
        <div style="font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.1em;">Exportiert</div>
        <div style="font-family: var(--font-mono); font-size: 13px; font-weight: 600;">${escapeHtml(filename)}</div>
      </div>
      <p style="margin: 0; font-size: 14px; color: var(--text-soft); line-height: 1.5;">
        Datei liegt jetzt im Downloads-Ordner. Soll sie direkt in ebox21 hochgeladen werden?
      </p>
      ${xlsmHint}
    `;
    card.insertBefore(extra, card.querySelector('.modal-actions'));

    els.modalTitle.textContent = 'Zu ebox21 hochladen?';
    els.modalText.textContent = '';
    els.modalCancel.textContent = 'Später';
    els.modalOk.textContent = 'ebox21 öffnen';
    els.modalOk.style.display = '';
    els.modal.hidden = false;

    _modalOkCallback = () => {
      window.open(uploadUrl, '_blank', 'noopener');
    };
    _modalCloseCallback = () => {
      const e = card.querySelector('.modal-extra');
      if (e) e.remove();
      els.modalOk.textContent = 'OK';
      els.modalCancel.textContent = 'Abbrechen';
    };
  }

  // UTF-8-Helfer für fflate
  function strFromU8(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    return fflate.strFromU8(u8);
  }
  function strToU8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return fflate.strToU8(s);
  }
  function generateExportFilename(ext) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    // Original-Dateinamen ohne Endung als Basis nehmen, damit sich die hochgeladene
    // Datei in ebox21 sofort der Quelle zuordnen lässt.
    let base = 'abnahme';
    if (state.filename) {
      base = state.filename.replace(/\.[^.]+$/, '').trim();
      // Falls der Name selbst schon einen vorherigen Zeitstempel enthält
      // (von vorherigen Exporten), den abschneiden, sonst wachsen die Namen ins Endlose.
      base = base.replace(/_\d{8}_\d{4}$/, '');
      if (!base) base = 'abnahme';
    }
    return `${base}_${stamp}.${ext || 'xlsx'}`;
  }

  /* ============================================================
     Modal & Toast
     ============================================================ */
  let _modalResolve = null;
  let _modalCloseCallback = null;
  let _modalOkCallback = null;
  function confirmModal(title, text) {
    return new Promise(resolve => {
      els.modalTitle.textContent = title;
      els.modalText.textContent = text;
      els.modalCancel.textContent = 'Abbrechen';
      els.modalOk.textContent = 'OK';
      els.modalOk.style.display = '';
      els.modal.hidden = false;
      _modalResolve = resolve;
    });
  }
  function closeModal() {
    els.modal.hidden = true;
    if (_modalCloseCallback) { _modalCloseCallback(); _modalCloseCallback = null; }
    if (_modalResolve) { _modalResolve(false); _modalResolve = null; }
    _modalOkCallback = null;
  }
  els.modalCancel.addEventListener('click', closeModal);
  els.modalOk.addEventListener('click', () => {
    els.modal.hidden = true;
    const okCb = _modalOkCallback;
    if (_modalCloseCallback) { _modalCloseCallback(); _modalCloseCallback = null; }
    if (_modalResolve) { _modalResolve(true); _modalResolve = null; }
    _modalOkCallback = null;
    if (okCb) okCb();
  });
  els.modal.addEventListener('click', e => { if (e.target === els.modal) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !els.modal.hidden) closeModal();
  });

  let toastTimer = null;
  function toast(msg, kind) {
    els.toast.textContent = msg;
    els.toast.className = 'toast' + (kind ? ' ' + kind : '');
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2400);
  }

  /* ============================================================
     Datei schließen
     ============================================================ */
  async function closeFile() {
    const stats = computeOverallStats();
    const hasChanges = stats.done + stats.defect > 0;
    if (hasChanges && !state.exported) {
      const ok = await confirmModal('Datei schließen?', 'Es gibt nicht exportierte Änderungen. Die Sitzung bleibt lokal gespeichert.');
      if (!ok) return;
    }
    Object.assign(state, {
      sessionId: null, fileBuffer: null, sheets: [], matrix: null, mode: 'list',
      annotations: {}, dirty: false, exported: false, currentVehicle: null,
      subVehicles: [], pendingApplySubs: new Set(),
      currentItemIdx: 0, visibleItems: [], screenStack: []
    });
    setSaveStatus('ok');
    navigateTo('start', false);
  }

  /* ============================================================
     Lifecycle
     ============================================================ */
  function beforeUnloadHandler(e) {
    const stats = computeOverallStats();
    const hasChanges = stats.done + stats.defect > 0;
    if (state.dirty || (hasChanges && !state.exported && state.sessionId)) {
      e.preventDefault();
      e.returnValue = 'Es gibt nicht exportierte Änderungen.';
      return e.returnValue;
    }
  }
  function bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.dirty) flushSave();
    });
    window.addEventListener('pagehide', () => { if (state.dirty) flushSave(); });
    window.addEventListener('beforeunload', beforeUnloadHandler);
  }
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  }

  /* ============================================================
     Init
     ============================================================ */
  /* ============================================================
     Sound-Engine (Web Audio)
     ============================================================ */
  let _audioCtx = null;
  let _soundEnabled = true;
  try { _soundEnabled = localStorage.getItem('abnahme:soundOff') !== '1'; } catch (_) {}

  function getAudioCtx() {
    if (!_audioCtx) {
      try {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) { _audioCtx = null; }
    }
    // iOS: Kontext kann suspended sein, bei User-Geste resumen
    if (_audioCtx && _audioCtx.state === 'suspended') {
      try { _audioCtx.resume(); } catch (_) {}
    }
    return _audioCtx;
  }

  // Erledigt: aufsteigender Doppelton (880 Hz → 1320 Hz)
  function playDoneSound() {
    if (!_soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const playTone = (freq, start, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Hüll­kurve: schneller Anstieg, Ausklang
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration);
    };
    playTone(880, now, 0.05);
    playTone(1320, now + 0.055, 0.07);
  }

  // Mangel: dissonanter Tritonus (311 Hz + 440 Hz simultan)
  function playDefectSound() {
    if (!_soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const playTone = (freq, start, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.13, start + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration);
    };
    playTone(311, now, 0.20);
    playTone(440, now, 0.20);
  }

  function setSoundEnabled(on) {
    _soundEnabled = on;
    try { localStorage.setItem('abnahme:soundOff', on ? '0' : '1'); } catch (_) {}
    const btn = document.getElementById('soundToggle');
    if (btn) btn.classList.toggle('muted', !on);
    const iconOn = document.getElementById('soundIconOn');
    const iconOff = document.getElementById('soundIconOff');
    if (iconOn) iconOn.hidden = !on;
    if (iconOff) iconOff.hidden = on;
  }

  /* ============================================================
     ebox21-Links: Default fest, per Einstellungen änderbar
     ============================================================ */
  const EBOX_DEFAULTS = {
    download: 'https://amt37-ffm.ebox21.de/public/download-shares/sfV7hEUFR37xfVwPbZxc4QQilYXnUnTI',
    upload: 'https://amt37-ffm.ebox21.de/#/public/shares-uploads/iogmJFSFYL0V8SmwwMoItNLgS8c7pIhd'
  };

  function getEboxLink(kind) {
    try {
      const stored = localStorage.getItem('abnahme:eboxUrl:' + kind);
      if (stored) return stored;
    } catch (_) {}
    return EBOX_DEFAULTS[kind];
  }

  function setupEboxLinks() {
    const dlUrl = getEboxLink('download');
    const upUrl = getEboxLink('upload');
    if (els.eboxDownloadBtn) els.eboxDownloadBtn.href = dlUrl;
    if (els.eboxUploadBtn) els.eboxUploadBtn.href = upUrl;
    if (els.eboxDownloadUrl) els.eboxDownloadUrl.value = dlUrl;
    if (els.eboxUploadUrl) els.eboxUploadUrl.value = upUrl;

    if (els.eboxSaveBtn) {
      els.eboxSaveBtn.addEventListener('click', () => {
        const newDl = (els.eboxDownloadUrl.value || '').trim();
        const newUp = (els.eboxUploadUrl.value || '').trim();
        try {
          if (newDl) localStorage.setItem('abnahme:eboxUrl:download', newDl);
          if (newUp) localStorage.setItem('abnahme:eboxUrl:upload', newUp);
          if (els.eboxDownloadBtn && newDl) els.eboxDownloadBtn.href = newDl;
          if (els.eboxUploadBtn && newUp) els.eboxUploadBtn.href = newUp;
          toast('Links gespeichert', 'success');
        } catch (err) {
          toast('Speichern fehlgeschlagen.', 'error');
        }
      });
    }
    if (els.eboxResetBtn) {
      els.eboxResetBtn.addEventListener('click', () => {
        try {
          localStorage.removeItem('abnahme:eboxUrl:download');
          localStorage.removeItem('abnahme:eboxUrl:upload');
        } catch (_) {}
        els.eboxDownloadUrl.value = EBOX_DEFAULTS.download;
        els.eboxUploadUrl.value = EBOX_DEFAULTS.upload;
        if (els.eboxDownloadBtn) els.eboxDownloadBtn.href = EBOX_DEFAULTS.download;
        if (els.eboxUploadBtn) els.eboxUploadBtn.href = EBOX_DEFAULTS.upload;
        toast('Zurückgesetzt');
      });
    }
  }

  function init() {
    els.modal.hidden = true;
    els.toast.hidden = true;

    els.fileInput.addEventListener('change', () => {
      const f = els.fileInput.files && els.fileInput.files[0];
      if (f) loadFromFile(f);
      els.fileInput.value = '';
    });

    // ebox21-Links setzen
    setupEboxLinks();

    els.manageBtn.addEventListener('click', () => navigateTo('sessions'));
    const helpBtn = document.getElementById('helpBtn');
    if (helpBtn) helpBtn.addEventListener('click', () => showTutorial(true));
    els.backBtn.addEventListener('click', () => navigateBack());

    els.exportBtn.addEventListener('click', exportXlsx);
    els.vehiclesExportBtn.addEventListener('click', exportXlsx);
    els.closeFileBtn.addEventListener('click', closeFile);
    els.vehiclesCloseBtn.addEventListener('click', closeFile);

    els.wizPrev.addEventListener('click', wizardPrev);
    els.wizNext.addEventListener('click', wizardNext);
    els.wizOverviewBtn.addEventListener('click', showOverview);

    bindLifecycle();
    checkResume();
    registerSW();
    setSaveStatus('ok');
    els.saveText.textContent = 'Bereit';

    // Sound-Toggle initialisieren
    const soundBtn = document.getElementById('soundToggle');
    if (soundBtn) {
      setSoundEnabled(_soundEnabled);
      soundBtn.addEventListener('click', () => setSoundEnabled(!_soundEnabled));
    }

    // Tutorial: jedes Mal anzeigen, außer "nicht mehr zeigen" wurde gewählt
    initTutorial();
  }

  function showTutorial(force) {
    const tut = document.getElementById('tutorial');
    if (!tut) return;
    if (!force) {
      let dontShow = false;
      try { dontShow = localStorage.getItem('abnahme:tutorialHide') === '1'; } catch (_) {}
      if (dontShow) {
        tut.hidden = true;
        return;
      }
    }
    tut.hidden = false;
    const closeBtn = document.getElementById('tutorialClose');
    const okBtn = document.getElementById('tutorialOk');
    const dontShowCb = document.getElementById('tutorialDontShow');
    // Beim manuellen Aufruf (force) macht "nicht mehr zeigen" wenig Sinn → ausblenden
    const dontShowWrap = dontShowCb ? dontShowCb.closest('label') : null;
    if (dontShowWrap) dontShowWrap.style.display = force ? 'none' : '';
    if (dontShowCb) dontShowCb.checked = false;
    const close = () => {
      if (!force && dontShowCb && dontShowCb.checked) {
        try { localStorage.setItem('abnahme:tutorialHide', '1'); } catch (_) {}
      }
      tut.hidden = true;
    };
    if (closeBtn) closeBtn.onclick = close;
    if (okBtn) okBtn.onclick = close;
    tut.onclick = e => { if (e.target === tut) close(); };
  }

  function initTutorial() {
    showTutorial(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
