// SPEER: survey regression, county residual map, county weather comparison.
(() => {
  const $ = id => document.getElementById(id);
  const fmt = (v, d = 3) => (v == null || !isFinite(v)) ? '–' : (v !== 0 && Math.abs(v) < Math.pow(10, -d) ? (+v).toExponential(1) : (+v).toFixed(d));
  const fmtP = p => (p == null || !isFinite(p)) ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- progress and error messages ----------
  const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  let doneTimer = null;
  function busy(msg) {
    clearTimeout(doneTimer);
    const t = $('toast'); t.className = 'toast busy'; t.hidden = false;
    $('toast-msg').textContent = msg;
  }
  function done(msg) {
    const t = $('toast'); t.className = 'toast done'; t.hidden = false;
    $('toast-msg').textContent = msg;
    clearTimeout(doneTimer); doneTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  function fail(msg) {
    clearTimeout(doneTimer);
    const t = $('toast'); t.className = 'toast fail'; t.hidden = false;
    $('toast-msg').textContent = msg;
  }
  window.addEventListener('error', e => fail(`Something went wrong: ${e.message}. The page may need a reload.`));
  window.addEventListener('unhandledrejection', e => fail(`Something went wrong: ${e.reason && e.reason.message || e.reason}. The page may need a reload.`));
  document.addEventListener('click', e => { if (e.target.id === 'toast-close') $('toast').hidden = true; });

  const S = {
    rows: [], cols: [], fileName: '',
    zipCounty: null,            // Map zip5 -> {fips, share, nCounties}
    rowFips: [],                // per-row county FIPS or null
    ivKind: {},                 // col -> 'number' | 'category'
    ivOn: new Set(),            // insertion order = order in results
    labels: {},                 // col -> display label from a predictor set
    wx: null,                   // Map fips -> {var: value}
    wxVars: [], wxDesc: {}, wxOn: new Set(),
    fit: null,                  // last model result + bookkeeping
    county: new Map(),          // fips -> {n, sumW, mean}
    topo: null, countyName: new Map(), stateName: new Map(), neighbors: new Map(),
    moran: null,
    centroid: new Map(),        // fips -> [lat, lon] in radians
    smooth: null, smoothKey: '',
  };

  // ---------------- loading ----------------
  function wireDrop(labelId, inputId, onFile) {
    const lab = $(labelId), inp = $(inputId);
    lab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
    inp.addEventListener('change', () => inp.files[0] && onFile(inp.files[0]));
    ['dragenter', 'dragover'].forEach(t => lab.addEventListener(t, e => { e.preventDefault(); lab.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => lab.addEventListener(t, e => { e.preventDefault(); lab.classList.remove('over'); }));
    lab.addEventListener('drop', e => e.dataTransfer.files[0] && onFile(e.dataTransfer.files[0]));
  }

  wireDrop('drop-survey', 'file-survey', file => {
    if (/\.xlsx?$/i.test(file.name)) return readExcel(file);
    const rows = []; let fields = null;
    busy(`Reading ${file.name}…`);
    Papa.parse(file, {
      header: true, skipEmptyLines: true, dynamicTyping: false, chunkSize: 512 * 1024,
      chunk: res => {
        if (!fields) fields = res.meta.fields;
        for (const r of res.data) rows.push(r);
        busy(`Reading ${file.name}: ${rows.length.toLocaleString()} rows so far…`);
      },
      complete: async () => {
        S.rows = rows; S.cols = (fields || []).filter(c => c !== '' && c != null);
        S.fileName = file.name; S.fit = null;
        $('survey-status').textContent = `${file.name}: ${S.rows.length.toLocaleString()} rows, ${S.cols.length} columns`;
        await onSurveyLoaded();
      },
      error: err => {
        $('survey-status').innerHTML = `<span class="err">Could not read the file: ${esc(err.message)}</span>`;
        fail(`Could not read ${file.name}: ${err.message}`);
      },
    });
  });

  wireDrop('drop-weather', 'file-weather', file => {
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: res => setWeather(res, file.name) });
  });

  $('missing-codes').addEventListener('change', () => { if (S.rows.length) { refreshIvKinds(); renderDvOnes(); } });

  function missingSet() {
    return new Set($('missing-codes').value.split(',').map(s => s.trim()).filter(Boolean));
  }
  function isMissing(v, miss) {
    if (v == null) return true;
    const t = String(v).trim();
    const u = t.toUpperCase();
    return t === '' || u === 'NA' || u === 'NAN' || u === '#NULL!' || t === '.' || miss.has(t);
  }
  const num = v => { const x = Number(String(v).trim()); return isFinite(x) ? x : NaN; };

  function distinctValues(col, miss, limit = 60) {
    const m = new Map();
    for (const r of S.rows) {
      const v = r[col];
      if (isMissing(v, miss)) continue;
      const k = String(v).trim();
      m.set(k, (m.get(k) || 0) + 1);
      if (m.size > limit) break;
    }
    return m;
  }

  function guessKind(col, miss) {
    const d = distinctValues(col, miss, 13);
    const allNum = [...d.keys()].every(k => isFinite(Number(k)));
    return (allNum && d.size > 12) ? 'number' : 'category';
  }

  function fillSelect(sel, opts, { none = null, pick = null } = {}) {
    sel.innerHTML = (none ? `<option value="">${esc(none)}</option>` : '') +
      opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    if (pick && opts.includes(pick)) sel.value = pick;
  }

  async function onSurveyLoaded() {
    $('step-place').removeAttribute('data-locked');
    $('step-model').removeAttribute('data-locked');
    const find = re => S.cols.find(c => re.test(c));
    const zip = find(/zip|postal/i) || find(/^Q13$/i), fips = find(/fips|county/i);
    fillSelect($('loc-col'), S.cols, { none: 'Choose a column', pick: zip || fips });
    fillSelect($('state-col'), S.cols, { none: 'None', pick: find(/^state$/i) });
    document.querySelector(`input[name=loc-kind][value=${!zip && fips ? 'fips' : 'zip'}]`).checked = true;
    fillSelect($('dv-col'), S.cols, { none: 'Choose a column' });
    fillSelect($('wt-col'), S.cols, { none: 'None (unweighted)', pick: S.cols.find(c => /^weight|wt$|_wt|weight_/i.test(c)) });
    S.ivOn = new Set(); S.ivKind = {}; S.labels = {};
    busy(`Checking ${S.cols.length} columns…`); await tick();
    refreshIvKinds();
    const firstFit = allPresets().findIndex(p => p.predictors.filter(q => S.cols.includes(q.col)).length >= p.predictors.length * 0.75);
    if (firstFit >= 0) { $('preset').value = String(firstFit); applyPreset(); } else { $('preset').value = ''; $('preset-note').textContent = ''; }
    fillSelect($('grp-by'), S.cols, { none: 'Choose a column', pick: S.cols.find(c => c === 'Party3') });
    grpOn.clear(); shapOn.clear(); SH = null; renderShapCands(); fillInteractionMenus(); fillComputedMenus(); renderGroupItems(); describeOutcome();
    busy('Placing respondents in counties…'); await tick();
    await placeRespondents();
    // show where respondents are while no model is fitted
    S.county = new Map();
    S.rowFips.forEach(f => { if (!f) return; const c = S.county.get(f) || { n: 0 }; c.n++; S.county.set(f, c); });
    $('map-layer').value = 'n'; drawMap();
    $('map-empty').hidden = false;
    $('map-empty').textContent = 'Respondents per county. Choose an outcome and predictors in step 4, then press Fit model.';
    done(`Loaded ${S.rows.length.toLocaleString()} respondents. Next: step 4, then Fit model.`);
  }

  function refreshIvKinds() {
    const miss = missingSet();
    for (const c of S.cols) if (!S.ivKind[c]) S.ivKind[c] = guessKind(c, miss);
    renderIvList();
  }

  function renderIvList() {
    const f = $('iv-filter').value.toLowerCase();
    const dv = $('dv-col').value, wt = $('wt-col').value;
    const locCols = new Set([$('loc-col').value].filter(Boolean));
    $('iv-list').innerHTML = S.cols
      .filter(c => c !== dv && c !== wt && !locCols.has(c) && c.toLowerCase().includes(f))
      .map(c => `<div class="iv-row"><input type="checkbox" data-col="${esc(c)}" ${S.ivOn.has(c) ? 'checked' : ''} aria-label="Use ${esc(c)}">
        <span class="name" title="${esc(c)}">${esc(c)}${labelOf(c) !== c ? ` <span class="label">${esc(labelOf(c))}</span>` : ''}</span>
        <button type="button" class="type" data-col="${esc(c)}" data-kind="${S.ivKind[c]}">${S.ivKind[c] === 'number' ? 'number' : 'category'}</button></div>`)
      .join('');
  }
  $('iv-filter').addEventListener('input', renderIvList);
  $('iv-list').addEventListener('change', e => {
    const c = e.target.dataset.col; if (!c) return;
    e.target.checked ? S.ivOn.add(c) : S.ivOn.delete(c);
  });
  $('iv-list').addEventListener('click', e => {
    if (!e.target.classList.contains('type')) return;
    const c = e.target.dataset.col;
    S.ivKind[c] = S.ivKind[c] === 'number' ? 'category' : 'number';
    e.target.dataset.kind = S.ivKind[c]; e.target.textContent = S.ivKind[c];
  });
  ['dv-col', 'wt-col'].forEach(id => $(id).addEventListener('change', () => { renderIvList(); renderDvOnes(); }));
  document.querySelectorAll('input[name=dv-kind]').forEach(r => r.addEventListener('change', renderDvOnes));

  // ---------- predictor sets ----------
  function savedPresets() {
    try { return JSON.parse(localStorage.getItem('SPEER-presets') || '[]'); } catch (e) { return []; }
  }
  function allPresets() {
    const base = window.SPEER_PRESETS || [];
    const expand = p => { const parent = p.extends && base.find(q => q.name === p.extends); return parent ? { ...p, predictors: [...expand(parent).predictors, ...p.predictors] } : p; };
    return [...base.map(expand), ...savedPresets().map(p => ({ ...p, saved: true }))];
  }
  function renderPresetMenu(pick) {
    const ps = allPresets();
    $('preset').innerHTML = '<option value="">Choose predictors by hand</option>' +
      ps.map((p, i) => `<option value="${i}">${esc(p.name)}${p.saved ? ' (saved in this browser)' : ''}</option>`).join('');
    if (pick != null) $('preset').value = pick;
  }
  function applyPreset() {
    const p = allPresets()[+$('preset').value];
    if ($('preset').value === '' || !p) { $('preset-note').textContent = ''; return; }
    S.ivOn = new Set(); S.labels = {};
    const missing = [];
    for (const q of p.predictors) {
      if (!S.cols.includes(q.col)) { missing.push(q.col); continue; }
      S.ivOn.add(q.col);
      if (q.kind) S.ivKind[q.col] = q.kind;
      if (q.label) S.labels[q.col] = q.label;
    }
    if (p.weight && S.cols.includes(p.weight)) $('wt-col').value = p.weight;
    renderIvList();
    $('preset-note').innerHTML = `${S.ivOn.size} predictors set. ${p.note ? esc(p.note) : ''}` +
      (missing.length ? ` <span class="warn">Not in this file: ${missing.map(esc).join(', ')}.</span>` : '');
  }
  $('preset').addEventListener('change', applyPreset);
  $('clear-ivs').addEventListener('click', () => { S.ivOn = new Set(); S.labels = {}; $('preset').value = ''; $('preset-note').textContent = ''; renderIvList(); });
  $('save-preset').addEventListener('click', () => {
    if (!S.ivOn.size) { $('preset-note').textContent = 'Tick some predictors first.'; return; }
    const name = prompt('Name for this predictor set');
    if (!name) return;
    const set = { name, weight: $('wt-col').value || null,
      predictors: [...S.ivOn].map(c => ({ col: c, label: S.labels[c] || null, kind: S.ivKind[c] })) };
    try {
      const list = savedPresets().filter(p => p.name !== name); list.push(set);
      localStorage.setItem('SPEER-presets', JSON.stringify(list));
      renderPresetMenu(String((window.SPEER_PRESETS || []).length + list.length - 1));
      $('preset-note').textContent = `Saved "${name}" in this browser (column names only, no survey data).`;
    } catch (e) { $('preset-note').textContent = 'This browser would not save the set.'; }
  });
  renderPresetMenu();

  function dvKind() { return document.querySelector('input[name=dv-kind]:checked').value; }

  function renderDvOnes() {
    const on = dvKind() === 'logit' && $('dv-col').value;
    $('dv-ones').hidden = !on;
    if (!on) return;
    const d = distinctValues($('dv-col').value, missingSet());
    const keys = [...d.keys()].sort((a, b) => (isFinite(a) && isFinite(b)) ? a - b : a.localeCompare(b));
    $('dv-ones-list').innerHTML = keys.map(k =>
      `<label><input type="checkbox" value="${esc(k)}"> ${esc(k)} <span class="hint">(${d.get(k)})</span></label>`).join('');
  }

  // ---------------- ZIP / FIPS matching ----------------
  async function loadZipCounty() {
    if (S.zipCounty) return S.zipCounty;
    try {
      const txt = await (await fetch('data/zip_county.csv')).text();
      if (!/^zip/i.test(txt.trim())) throw new Error('missing');
      const m = new Map();
      Papa.parse(txt, { header: true, skipEmptyLines: true }).data.forEach(r =>
        m.set(String(r.zip).padStart(5, '0'), { fips: String(r.county_fips).padStart(5, '0'), share: r.pop_share === '' ? NaN : +r.pop_share, nCounties: +r.n_counties }));
      S.zipCounty = m;
    } catch (e) { S.zipCounty = false; }
    return S.zipCounty;
  }

  function cleanZip(v) {
    const t = String(v ?? '').trim().split(/[-\s]/)[0].replace(/\.0+$/, '');
    if (!/^\d{3,5}$/.test(t)) return null;
    return t.padStart(5, '0');
  }
  function cleanFips(v) {
    const t = String(v ?? '').trim().replace(/\.0+$/, '');
    if (!/^\d{4,5}$/.test(t)) return null;
    return t.padStart(5, '0');
  }

  function locKind() { return document.querySelector('input[name=loc-kind]:checked').value; }

  async function placeRespondents() {
    const kind = locKind(), out = $('place-status');
    S.rowFips = new Array(S.rows.length).fill(null);
    if (!S.rows.length) return;
    const col = $('loc-col').value;
    if (!col) {
      out.textContent = kind === 'zip' ? 'No ZIP code column was found. Choose the column that holds each respondent\'s ZIP code.' : 'Choose the column that holds each respondent\'s county FIPS code.';
      return;
    }
    let matched = 0, bad = 0, unknown = 0, note = '';
    if (kind === 'zip') {
      const zc = await loadZipCounty();
      if (!zc) {
        out.innerHTML = '<span class="err">data/zip_county.csv could not be loaded. It ships with the repo; check that the data folder was uploaded.</span>';
        return;
      }
      let split = 0;
      S.rows.forEach((r, i) => {
        const z = cleanZip(r[col]);
        if (!z) { bad++; return; }
        const hit = zc.get(z);
        if (!hit) { unknown++; return; }
        S.rowFips[i] = hit.fips; matched++;
        if (hit.nCounties > 1 && !(hit.share >= 0.9)) split++;
      });
      note = (unknown ? ` ${unknown} ZIP codes are not in the lookup (retired ZIPs, or outside the 50 states and DC).` : '') +
        (split ? ` <span class="warn">${split} live in ZIPs split between counties with less than 90% of the ZIP's population in the assigned county.</span>` : '');
    } else {
      S.rows.forEach((r, i) => {
        const f = cleanFips(r[col]);
        if (!f) { bad++; return; }
        if (S.countyName.size && !S.countyName.has(f)) { unknown++; return; }
        S.rowFips[i] = f; matched++;
      });
      note = unknown ? ` ${unknown} codes are not on the county map.` : '';
    }
    if (bad > 0.5 * S.rows.length) note += ` <span class="err">Most values in ${esc(col)} do not look like ${kind === 'zip' ? 'ZIP codes' : 'county FIPS codes'}. Check the column choice.</span>`;
    // optional cross-check against a reported state
    const stC = $('state-col').value;
    if (stC && matched) {
      let mism = 0;
      S.rows.forEach((r, i) => {
        const f = S.rowFips[i]; if (!f) return;
        const st = String(r[stC] ?? '').trim().toUpperCase();
        if (!st) return;
        const want = STATE_ABBR[f.slice(0, 2)], wantName = (S.stateName.get(f.slice(0, 2)) || '').toUpperCase();
        if (st !== want && st !== wantName && st !== f.slice(0, 2)) mism++;
      });
      note += mism ? ` <span class="warn">${mism} respondents are placed in a county outside the state in ${esc(stC)}.</span>` : ` All placements agree with ${esc(stC)}.`;
    }
    const counties = new Set(S.rowFips.filter(Boolean)).size;
    out.innerHTML = `<b>${matched.toLocaleString()}</b> of ${S.rows.length.toLocaleString()} respondents placed in ${counties.toLocaleString()} counties.` +
      (bad ? ` ${bad} blank or malformed.` : '') + note;
    if (S.fit) aggregateCounties();
  }
  ['loc-col', 'state-col'].forEach(id => $(id).addEventListener('change', () => { renderIvList(); placeRespondents(); }));
  document.querySelectorAll('input[name=loc-kind]').forEach(r => r.addEventListener('change', placeRespondents));

  const STATE_ABBR = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' };

  // us-atlas albers files use this projection; used to find county centroids for smoothing
  const PROJ = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);

  // ---------------- weather table ----------------
  async function loadDefaultWeather() {
    busy('Loading the county weather table…');
    try {
      const txt = await (await fetch('data/county_weather.csv')).text();
      if (!/^fips/i.test(txt.trim())) throw new Error('missing');
      try {
        const dtxt = await (await fetch('data/county_weather_dictionary.csv')).text();
        if (/^variable/i.test(dtxt.trim()))
          Papa.parse(dtxt, { header: true, skipEmptyLines: true }).data.forEach(r => S.wxDesc[r.variable] = r.description);
      } catch (e) { /* dictionary optional */ }
      setWeather(Papa.parse(txt, { header: true, skipEmptyLines: true }), 'data/county_weather.csv');
      $('toast').hidden = true;
    } catch (e) {
      $('toast').hidden = true;
      $('weather-status').innerHTML = 'No county weather table in data/ yet. Build it with scripts/build_county_weather.py, or load any CSV with a <b>fips</b> column plus numeric county variables.';
    }
  }

  function setWeather(res, name) {
    const fcol = res.meta.fields.find(f => /^fips$/i.test(f)) || res.meta.fields.find(f => /fips/i.test(f));
    if (!fcol) { $('weather-status').innerHTML = `<span class="err">${esc(name)} has no fips column.</span>`; return; }
    const vars = res.meta.fields.filter(f => f !== fcol && res.data.some(r => isFinite(num(r[f])) && String(r[f]).trim() !== ''));
    const m = new Map();
    res.data.forEach(r => {
      const f = cleanFips(r[fcol]); if (!f) return;
      const o = {}; vars.forEach(v => { const x = num(r[v]); o[v] = (String(r[v]).trim() === '' ? NaN : x); });
      m.set(f, o);
    });
    S.wx = m; S.wxVars = vars; S.wxOn = new Set();
    $('weather-status').innerHTML = `${esc(name)}: ${m.size.toLocaleString()} counties, ${vars.length} variables.`;
    $('wx-list').innerHTML = vars.map(v => `<label class="wx-row"><input type="checkbox" data-var="${esc(v)}">
      <span class="name" title="${esc(v)}">${esc(v)}</span>${S.wxDesc[v] ? `<span class="desc">${esc(S.wxDesc[v])}</span>` : ''}</label>`).join('');
    $('add-weather').disabled = false;
    const layer = $('map-layer');
    const was = layer.value;
    layer.innerHTML = '<option value="smooth">Smoothed residual</option><option value="resid">Mean residual by county</option><option value="n">Respondents</option>' +
      vars.map(v => `<option value="wx:${esc(v)}">${esc(v)}</option>`).join('');
    if ([...layer.options].some(o => o.value === was)) layer.value = was;
    fillSelect($('scatter-x'), vars);
    if (S.fit) { drawCountyAnalysis(); drawMap(); }
  }
  $('wx-list').addEventListener('change', e => {
    const v = e.target.dataset.var; if (!v) return;
    e.target.checked ? S.wxOn.add(v) : S.wxOn.delete(v);
    if (e.target.checked) $('scatter-x').value = v;
    if (S.fit) drawCountyAnalysis();
  });

  // ---------------- model ----------------
  $('fit').addEventListener('click', fitModel);

  async function fitModel() {
    busy('Fitting the model…'); await tick();
    try { if (await fitModelInner() !== false) done('Model fitted. The map shows the residuals.'); }
    catch (e) { fail(`The model could not be fitted: ${e.message}`); }
  }

  const labelOf = c => S.labels[c] || (window.SPEER_LABELS || {})[c] || c;

  // Reads the step 4 settings. Returns { error } or the pieces needed to build a design matrix.
  function modelSettings() {
    const dv = $('dv-col').value, wt = $('wt-col').value, kind = dvKind(), seKind = $('se-kind').value;
    const ivs = [...S.ivOn].filter(c => S.cols.includes(c) && c !== dv && c !== wt);
    const useWx = $('add-weather').checked ? [...S.wxOn] : [];
    if (!dv) return { error: 'Choose an outcome column.' };
    if (!ivs.length && !useWx.length) return { error: 'Tick at least one predictor.' };
    const ones = new Set([...document.querySelectorAll('#dv-ones-list input:checked')].map(i => i.value));
    if (kind === 'logit' && !ones.size) return { error: 'Tick the answers that count as yes.' };
    if ($('add-weather').checked && !useWx.length) return { error: 'Tick weather variables in step 3, or untick “Add selected weather variables”.' };
    return { dv, wt, kind, seKind, ivs, useWx, ones };
  }

  // Terms are { name, get(row, i) -> number | null (null = missing) }.
  function termsFor(ivs, miss) {
    const terms = [];
    for (const c of ivs) {
      const L = labelOf(c);
      if (S.ivKind[c] === 'number') {
        terms.push({ name: L, col: c, get: r => { if (isMissing(r[c], miss)) return null; const x = num(r[c]); return isFinite(x) ? x : null; } });
      } else {
        const d = distinctValues(c, miss, 200);
        if (d.size > 60) return { error: `${c} has more than 60 answers. Mark it as a number or leave it out.` };
        const sorted = [...d.entries()].sort((p, q) => q[1] - p[1]);
        const ref = sorted[0][0];
        sorted.slice(1).map(e => e[0]).sort((p, q) => (isFinite(p) && isFinite(q)) ? p - q : p.localeCompare(q))
          .forEach(l => terms.push({ name: `${L}: ${l} (vs ${ref})`, col: c, level: l,
            get: r => isMissing(r[c], miss) ? null : (String(r[c]).trim() === l ? 1 : 0) }));
      }
    }
    return terms;
  }

  function buildDesign(set, terms) {
    const miss = missingSet(), needCounty = set.seKind === 'cluster' || set.useWx.length > 0;
    const allTerms = [...terms, ...set.useWx.map(v => ({ name: `[county] ${v}`, get: (r, i) => { const x = S.wx.get(S.rowFips[i])?.[v]; return x != null && isFinite(x) ? x : null; } }))];
    const X = [], y = [], w = [], cl = [], idx = [];
    let dropped = 0, noCounty = 0;
    S.rows.forEach((r, i) => {
      const fips = S.rowFips[i];
      if (needCounty && !fips) { noCounty++; return; }
      if (isMissing(r[set.dv], miss)) { dropped++; return; }
      let yi;
      if (set.kind === 'logit') yi = set.ones.has(String(r[set.dv]).trim()) ? 1 : 0;
      else { yi = num(r[set.dv]); if (!isFinite(yi)) { dropped++; return; } }
      let wi = 1;
      if (set.wt) { wi = num(r[set.wt]); if (!isFinite(wi) || wi <= 0) { dropped++; return; } }
      const x = [1];
      for (const t of allTerms) { const v = t.get(r, i); if (v == null) { dropped++; return; } x.push(v); }
      X.push(x); y.push(yi); w.push(wi); cl.push(fips); idx.push(i);
    });
    if (X.length < 10) return { error: `Only ${X.length} complete rows. Check the missing codes and predictor types.` };
    const names = ['(Intercept)', ...allTerms.map(t => t.name)];
    // drop columns that never vary in the complete rows
    const keep = names.map((_, j) => j === 0 || X.some(r => r[j] !== X[0][j]));
    return { X: X.map(r => r.filter((_, j) => keep[j])), names: names.filter((_, j) => keep[j]),
      terms: [null, ...allTerms].filter((_, j) => keep[j]), y, w, cl, idx, dropped, noCounty };
  }

  function runModel(set, D) {
    return (set.kind === 'logit' ? Stats.logit : Stats.ols)(D.X, D.y, set.wt ? D.w : null, { se: set.seKind, clusters: D.cl });
  }

  async function fitModelInner() {
    const status = $('model-status');
    const bail = msg => { status.innerHTML = `<span class="err">${esc(msg)}</span>`; $('toast').hidden = true; return false; };
    const set = modelSettings(); if (set.error) return bail(set.error);
    const terms = termsFor(set.ivs, missingSet()); if (terms.error) return bail(terms.error);
    const D = buildDesign(set, terms); if (D.error) return bail(D.error);
    const res = runModel(set, D); if (res.error) return bail(res.error);

    S.fit = { ...res, names: D.names, X: D.X, idx: D.idx, w: set.wt ? D.w : null, dv: set.dv, kind: set.kind, ivs: set.ivs, useWx: set.useWx,
      cluster: set.seKind === 'cluster', dropped: D.dropped, noCounty: D.noCounty, set,
      residSD: Math.sqrt(res.resid.reduce((s, e) => s + e * e, 0) / res.resid.length) };
    S.vif = null;
    status.innerHTML = `Fitted on <b>${res.n.toLocaleString()}</b> respondents.` +
      (D.dropped ? ` ${D.dropped.toLocaleString()} dropped for missing answers.` : '') +
      (D.noCounty ? ` ${D.noCounty.toLocaleString()} dropped with no county.` : '') +
      (res.kind === 'logit' && !res.converged ? ' <span class="warn">The logistic fit did not fully converge.</span>' : '');

    // fixed color range: set from the outcome type, then left to the slider
    const r0 = set.kind === 'logit' ? 0.5 : Math.max(0.05, Math.round(S.fit.residSD * 20) / 20);
    const rg = $('range'); rg.max = Math.max(3, r0 * 3); rg.step = set.kind === 'logit' ? 0.01 : 0.05; rg.value = r0;
    $('range-out').textContent = fmt(r0, 2);
    renderCoefTable();
    if ($('tab-model').hidden) showTab('model');
    if (document.querySelector('details.diag').open) renderVif();
    busy('Averaging residuals by county and smoothing the map…'); await tick();
    if ($('map-layer').value === 'n') $('map-layer').value = 'smooth';
    aggregateCounties();
  }

  const SE_TXT = { hc1: 'robust (HC1)', hc3: 'robust (HC3)', classical: 'classical (model-based)' };
  function seText(f) { return f.clusters ? `clustered on ${f.clusters.toLocaleString()} counties` : SE_TXT[f.seKind] || f.seKind; }

  function coefTableHTML(f, rowsIdx) {
    const stat = f.kind === 'logit' ? 'z' : 't';
    const idx = rowsIdx || f.names.map((_, j) => j);
    return `<div class="table-scroll"><table><thead><tr><th>Term</th><th class="num">Estimate</th><th class="num">SE</th><th class="num">${stat}</th><th class="num">p</th><th class="num">2.5%</th><th class="num">97.5%</th></tr></thead><tbody>` +
      idx.map(j => `<tr class="${f.p[j] < 0.05 && j > 0 ? 'sig' : ''}"><td>${esc(f.names[j])}</td><td class="num">${fmt(f.beta[j])}</td><td class="num">${fmt(f.se[j])}</td><td class="num">${fmt(f.stat[j], 2)}</td><td class="num">${fmtP(f.p[j])}</td><td class="num">${fmt(f.ci[j][0])}</td><td class="num">${fmt(f.ci[j][1])}</td></tr>`).join('') +
      '</tbody></table></div>';
  }

  function renderCoefTable() {
    const f = S.fit;
    $('model-summary').innerHTML =
      `${f.kind === 'logit' ? 'Logistic' : 'Linear'} model of <b>${esc(labelOf(f.dv))}</b>. n = <b>${f.n.toLocaleString()}</b>. ` +
      (f.kind === 'logit' ? `McFadden pseudo R² = <b>${fmt(f.pseudoR2)}</b>. Coefficients are log-odds.` : `R² = <b>${fmt(f.r2)}</b>, adjusted R² = <b>${fmt(f.adjR2)}</b>.`) +
      ` Standard errors ${seText(f)}.` + (f.w ? ' Survey weights applied.' : ' Unweighted.');
    $('coef-table').innerHTML = coefTableHTML(f) + '<p class="hint">Rows marked on the left have p &lt; 0.05.</p>';
    drawTChart();
    $('export-coef').disabled = false;
  }

  // bar chart of t (or z) values, or coefficients with 95% intervals, colored by p-value band
  const PBANDS = [[0.001, '#3E7CB8', 'p ≤ 0.001'], [0.01, '#E8934A', '0.001 < p ≤ 0.01'], [0.05, '#5AAE61', '0.01 < p ≤ 0.05'], [Infinity, '#D5D9DB', 'p > 0.05']];
  const bandOf = p => (PBANDS.find(b => p <= b[0]) || PBANDS[3])[1];
  function niceMax(v) { const e = Math.pow(10, Math.floor(Math.log10(v))); return [1, 2, 2.5, 5, 10].map(m => m * e).find(m => m >= v); }
  function drawTChart() {
    const f = S.fit, g = d3.select('#tchart'); g.selectAll('*').remove();
    if (!f) return;
    const mode = $('chart-kind').value;
    const rows = f.names.map((nm, j) => ({ nm, t: f.stat[j], p: f.p[j], b: f.beta[j], lo: f.ci[j][0], hi: f.ci[j][1] })).slice(1);
    const W = 560, row = 20, m = { l: 190, r: 16, t: 8, b: 76 }, H = m.t + rows.length * row + m.b;
    g.attr('viewBox', `0 0 ${W} ${H}`);
    let lim;
    if (mode === 't') lim = Math.max(8, Math.ceil(d3.max(rows, r => Math.abs(r.t)) || 0));
    else lim = niceMax(d3.max(rows, r => Math.max(Math.abs(r.lo), Math.abs(r.hi))) || 1);
    const x = d3.scaleLinear().domain([-lim, lim]).range([m.l, W - m.r]);
    const y = i => m.t + i * row, bottom = m.t + rows.length * row;
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${bottom})`).call(d3.axisBottom(x).ticks(8));
    g.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', bottom + 30).attr('text-anchor', 'middle')
      .text(mode === 't' ? (f.kind === 'logit' ? 'z value' : 't value') : (f.kind === 'logit' ? 'Coefficient (log-odds)' : 'Coefficient'));
    if (mode === 't') [-1.96, 1.96].forEach(v => g.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', m.t).attr('y2', bottom).attr('stroke', '#C3CACD').attr('stroke-dasharray', '2 3'));
    g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', m.t).attr('y2', bottom).attr('stroke', '#1B2429').attr('stroke-dasharray', '3 3');
    rows.forEach((r, i) => {
      const v = mode === 't' ? r.t : r.b;
      g.append('rect').attr('x', Math.min(x(0), x(v))).attr('y', y(i) + 3).attr('width', Math.abs(x(v) - x(0))).attr('height', row - 6).attr('fill', bandOf(r.p))
        .append('title').text(`${r.nm}: coefficient ${fmt(r.b)}, t ${fmt(r.t, 2)}, p ${fmtP(r.p)}`);
      if (mode === 'coef') {
        const cy = y(i) + row / 2, lo = x(Math.max(-lim, r.lo)), hi = x(Math.min(lim, r.hi));
        g.append('line').attr('x1', lo).attr('x2', hi).attr('y1', cy).attr('y2', cy).attr('stroke', '#1B2429');
        [lo, hi].forEach(xx => g.append('line').attr('x1', xx).attr('x2', xx).attr('y1', cy - 4).attr('y2', cy + 4).attr('stroke', '#1B2429'));
      }
      g.append('text').attr('x', m.l - 8).attr('y', y(i) + row / 2 + 4).attr('text-anchor', 'end').text(r.nm.length > 30 ? r.nm.slice(0, 29) + '…' : r.nm).append('title').text(r.nm);
    });
    PBANDS.forEach((b, i) => {
      const lx = m.l - 60 + (i % 2) * 170, ly = bottom + 44 + Math.floor(i / 2) * 16;
      g.append('rect').attr('x', lx).attr('y', ly).attr('width', 12).attr('height', 10).attr('fill', b[1]);
      g.append('text').attr('x', lx + 16).attr('y', ly + 9).attr('font-size', 11).text(b[2]);
    });
  }
  $('chart-kind').addEventListener('change', drawTChart);

  function renderVif() {
    const f = S.fit;
    if (!f) { $('vif').textContent = 'Fit a model first.'; return; }
    if (!S.vif) S.vif = Stats.collinearity(f.X);
    const rows = f.names.slice(1).map((nm, j) => ({ nm, v: S.vif.vif[j] })).sort((p, q) => q.v - p.v);
    $('vif').innerHTML = `Condition number of the predictor matrix with its constant: <b>${fmt(S.vif.cond, 1)}</b>. Variance inflation factors are unweighted.` +
      `<div class="table-scroll"><table><thead><tr><th>Term</th><th class="num">VIF</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td>${esc(r.nm)}</td><td class="num">${isFinite(r.v) ? fmt(r.v, 2) : '∞'}</td></tr>`).join('') + '</tbody></table></div>';
  }
  document.querySelector('details.diag').addEventListener('toggle', e => { if (e.target.open) renderVif(); });

  $('export-coef').addEventListener('click', () => {
    const f = S.fit; if (!f) return;
    const stat = f.kind === 'logit' ? 'z' : 't';
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [['term', 'estimate', 'se', stat, 'p', 'ci_2.5', 'ci_97.5'].join(',')];
    f.names.forEach((nm, j) => lines.push([q(nm), f.beta[j], f.se[j], f.stat[j], f.p[j], f.ci[j][0], f.ci[j][1]].join(',')));
    lines.push('', q(`model: ${f.kind}; outcome: ${f.dv}; n: ${f.n}; ${f.kind === 'logit' ? 'McFadden pseudo R2: ' + f.pseudoR2 : 'R2: ' + f.r2 + '; adjusted R2: ' + f.adjR2}; SE: ${seText(f)}; weights: ${f.w ? 'yes' : 'no'}`));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `SPEER_model_${f.dv.replace(/\W+/g, '_')}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  });

  // ---------------- county aggregation ----------------
  function aggregateCounties() {
    const f = S.fit; S.county = new Map(); S.moran = null; S.smooth = null; $('moran-out').textContent = '';
    if (!f) return;
    f.idx.forEach((ri, k) => {
      const fips = S.rowFips[ri]; if (!fips) return;
      const wi = f.w ? f.w[k] : 1;
      let c = S.county.get(fips);
      if (!c) { c = { n: 0, sumW: 0, sumWR: 0 }; S.county.set(fips, c); }
      c.n++; c.sumW += wi; c.sumWR += wi * f.resid[k];
    });
    S.county.forEach(c => c.mean = c.sumWR / c.sumW);
    $('map-empty').hidden = S.county.size > 0;
    if (!S.county.size) $('map-empty').textContent = 'No fitted respondents have a county. Check step 2.';
    $('run-moran').disabled = !S.county.size; $('export-county').disabled = !S.county.size;
    drawMap(); drawCountyAnalysis();
  }

  const minN = () => +$('minn').value;
  function qualifying() {
    const m = new Map();
    S.county.forEach((c, f) => { if (c.n >= minN()) m.set(f, c); });
    return m;
  }

  // ---------------- map ----------------
  const svg = d3.select('#map');
  let countyPaths;
  const RESID = d3.interpolateRgbBasis(['#2C5D8A', '#9DB8CF', '#F4F4F2', '#D9A193', '#A33A2E']);
  const SEQ = d3.interpolateRgbBasis(['#EEF3F2', '#8FB9B8', '#0F5E66', '#08343A']);
  const wxDomains = {};

  async function initMap() {
    S.topo = await (await fetch('data/counties-albers-10m.json')).json();
    const geoms = S.topo.objects.counties.geometries;
    S.topo.objects.states.geometries.forEach(g => S.stateName.set(g.id, g.properties.name));
    geoms.forEach(g => S.countyName.set(g.id, g.properties.name));
    topojson.neighbors(geoms).forEach((nb, i) => S.neighbors.set(geoms[i].id, nb.map(j => geoms[j].id)));
    const feats = topojson.feature(S.topo, S.topo.objects.counties).features;
    const pat = svg.append('defs').append('pattern').attr('id', 'nodata').attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 5).attr('height', 5).attr('patternTransform', 'rotate(45)');
    pat.append('rect').attr('width', 5).attr('height', 5).attr('fill', '#EEF0F1');
    pat.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 5).attr('stroke', '#C3CACD').attr('stroke-width', 1.4);
    const path = d3.geoPath();
    feats.forEach(f => {
      const ll = PROJ.invert(path.centroid(f));
      if (ll) S.centroid.set(f.id, [ll[1] * Math.PI / 180, ll[0] * Math.PI / 180]);
    });
    countyPaths = svg.append('g').selectAll('path')
      .data(feats)
      .join('path').attr('class', 'county').attr('d', path).attr('fill', '#E6E9EA');
    svg.append('path').attr('class', 'states').attr('d', path(topojson.mesh(S.topo, S.topo.objects.states, (a, b) => a !== b)));
    svg.append('path').attr('class', 'nation').attr('d', path(topojson.feature(S.topo, S.topo.objects.nation)));
    countyPaths.on('mousemove', showTip).on('mouseleave', hideTip);
    drawLegend();
  }

  function layer() { return $('map-layer').value; }

  // Gaussian kernel smoothing of residuals between county centroids.
  // Each county's value is the survey-weighted mean of respondent residuals,
  // with respondents weighted by exp(-d^2 / 2h^2) of the distance from their
  // county's centroid. neff is the kernel-weighted respondent count.
  function smoothed() {
    const h = +$('bw').value, key = `${h}|${S.county.size}|${S.fit ? S.fit.n + S.fit.dv : ''}`;
    if (S.smooth && S.smoothKey === key) return S.smooth;
    const R = 6371, cut = 3 * h;
    const src = [...S.county].map(([f, c]) => ({ ll: S.centroid.get(f), c })).filter(d => d.ll);
    const out = new Map();
    S.centroid.forEach(([la1, lo1], f) => {
      let sw = 0, swr = 0, ne = 0;
      const cos1 = Math.cos(la1);
      for (const { ll: [la2, lo2], c } of src) {
        const dla = la2 - la1, dlo = lo2 - lo1;
        if (Math.abs(dla) * R > cut) continue;
        const a = Math.sin(dla / 2) ** 2 + cos1 * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
        const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
        if (d > cut) continue;
        const k = Math.exp(-0.5 * (d / h) ** 2);
        sw += k * c.sumW; swr += k * c.sumWR; ne += k * c.n;
      }
      if (sw > 0) out.set(f, { mean: swr / sw, neff: ne });
    });
    S.smooth = out; S.smoothKey = key;
    return out;
  }

  function drawMap() {
    if (!countyPaths) return;
    const L = layer(), range = +$('range').value, mn = minN();
    $('range-wrap').style.visibility = (L === 'resid' || L === 'smooth') ? 'visible' : 'hidden';
    $('bw-wrap').style.display = L === 'smooth' ? '' : 'none';
    $('minn-label').textContent = L === 'smooth' ? 'Minimum respondents within smoothing distance' : 'Minimum respondents per county';
    let fill;
    if (L === 'smooth') {
      const sm = S.fit ? smoothed() : new Map();
      fill = id => { const c = sm.get(id); return c && c.neff >= mn ? RESID(0.5 + Math.max(-1, Math.min(1, c.mean / range)) / 2) : null; };
    } else if (L === 'resid') {
      fill = id => { const c = S.county.get(id); return c && c.n >= mn ? RESID(0.5 + Math.max(-1, Math.min(1, c.mean / range)) / 2) : null; };
    } else if (L === 'n') {
      const s = d3.scaleLog().domain([1, 100]).clamp(true);
      fill = id => { const c = S.county.get(id); return c ? SEQ(s(c.n)) : null; };
    } else {
      const v = L.slice(3), dom = wxDomain(v);
      fill = id => { const x = S.wx?.get(id)?.[v]; return x != null && isFinite(x) ? SEQ(Math.max(0, Math.min(1, (x - dom[0]) / (dom[1] - dom[0] || 1)))) : null; };
    }
    countyPaths.attr('fill', d => fill(d.id) || (L === 'smooth' ? (S.fit ? 'url(#nodata)' : '#E6E9EA') : S.county.has(d.id) ? '#D5DADC' : '#E6E9EA'));
    drawLegend();
  }

  // weather colors use the 2nd–98th percentile of all counties, fixed per variable
  function wxDomain(v) {
    if (!wxDomains[v]) {
      const vals = [...S.wx.values()].map(o => o[v]).filter(isFinite).sort((a, b) => a - b);
      wxDomains[v] = [d3.quantileSorted(vals, 0.02), d3.quantileSorted(vals, 0.98)];
    }
    return wxDomains[v];
  }

  function drawLegend() {
    const g = d3.select('#legend'); g.selectAll('*').remove();
    const L = layer(), W = 240, x0 = 10;
    let interp, lo, hi, title;
    if (L === 'smooth') { const r = +$('range').value; interp = RESID; lo = -r; hi = r; title = `Smoothed residual (Gaussian kernel, ${$('bw').value} km)`; }
    else if (L === 'resid') { const r = +$('range').value; interp = RESID; lo = -r; hi = r; title = S.fit?.kind === 'logit' ? 'Mean residual (observed minus predicted probability)' : 'Mean residual (observed minus predicted)'; }
    else if (L === 'n') { interp = SEQ; lo = 1; hi = 100; title = 'Respondents per county (log scale)'; }
    else { interp = SEQ; [lo, hi] = wxDomain(L.slice(3)); title = L.slice(3); }
    const defs = g.append('defs').append('linearGradient').attr('id', 'lg');
    d3.range(0, 1.01, 0.1).forEach(t => defs.append('stop').attr('offset', t).attr('stop-color', interp(t)));
    g.append('text').attr('x', x0).attr('y', 11).attr('font-size', 12).attr('fill', '#56636B').text(title);
    g.append('rect').attr('x', x0).attr('y', 16).attr('width', W).attr('height', 10).attr('fill', 'url(#lg)');
    const lab = v => Math.abs(v) >= 100 ? d3.format(',.0f')(v) : d3.format('.2~f')(v);
    [[lo, 'start', x0], [hi, 'end', x0 + W]].forEach(([v, a, x]) =>
      g.append('text').attr('x', x).attr('y', 40).attr('text-anchor', a).attr('font-size', 11).attr('fill', '#1B2429').text(((L === 'resid' || L === 'smooth') && v > 0 ? '+' : '') + lab(v)));
    if (L === 'resid' || L === 'smooth') g.append('text').attr('x', x0 + W / 2).attr('y', 40).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', '#1B2429').text('0');
    if (L === 'smooth') {
      const lp = g.select('defs').append('pattern').attr('id', 'nodata-lg').attr('patternUnits', 'userSpaceOnUse').attr('width', 4).attr('height', 4).attr('patternTransform', 'rotate(45)');
      lp.append('rect').attr('width', 4).attr('height', 4).attr('fill', '#EEF0F1');
      lp.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 4).attr('stroke', '#C3CACD').attr('stroke-width', 1.2);
    }
    g.append('rect').attr('x', x0 + W + 16).attr('y', 16).attr('width', 12).attr('height', 10).attr('fill', L === 'smooth' ? 'url(#nodata-lg)' : '#D5DADC');
    g.append('text').attr('x', x0 + W + 32).attr('y', 25).attr('font-size', 11).attr('fill', '#56636B').text(L === 'smooth' ? 'too few nearby' : '< min n');
  }

  function showTip(ev, d) {
    const tip = $('tip'), c = S.county.get(d.id);
    const st = S.stateName.get(d.id.slice(0, 2)) || '';
    let h = `<b>${esc(S.countyName.get(d.id) || d.id)}${st ? ', ' + esc(st) : ''}</b> (${d.id})<br>`;
    h += c ? `${c.n} respondent${c.n > 1 ? 's' : ''}` + (S.fit ? `, mean residual ${c.mean > 0 ? '+' : ''}${fmt(c.mean)}` : '') : (S.fit ? 'No fitted respondents' : 'No respondents');
    if (c && c.n < minN()) h += ' (below min n)';
    const L = layer();
    if (L === 'smooth' && S.fit) { const sm = smoothed().get(d.id); h += sm ? `<br>Smoothed ${sm.mean > 0 ? '+' : ''}${fmt(sm.mean)} from ${fmt(sm.neff, 1)} weighted respondents nearby` : '<br>No respondents within smoothing distance'; }
    if (L.startsWith('wx:')) { const x = S.wx?.get(d.id)?.[L.slice(3)]; h += `<br>${esc(L.slice(3))}: ${x != null && isFinite(x) ? fmt(x, 2) : 'no data'}`; }
    tip.innerHTML = h; tip.hidden = false;
    const box = $('map').parentElement.getBoundingClientRect();
    let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
    if (x > box.width - 270) x -= 290;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    countyPaths.classed('hover', p => p.id === d.id);
  }
  function hideTip() { $('tip').hidden = true; countyPaths.classed('hover', false); }

  $('map-layer').addEventListener('change', drawMap);
  let bwTimer = null;
  $('bw').addEventListener('input', () => {
    $('bw-out').textContent = $('bw').value + ' km';
    clearTimeout(bwTimer);
    bwTimer = setTimeout(async () => { if (S.fit) { busy('Smoothing…'); await tick(); } drawMap(); if (S.fit) $('toast').hidden = true; }, 120);
  });
  $('range').addEventListener('input', () => { $('range-out').textContent = fmt(+$('range').value, 2); drawMap(); drawCountyAnalysis(); });
  $('minn').addEventListener('input', () => {
    $('minn-out').textContent = $('minn').value; S.moran = null; $('moran-out').textContent = '';
    drawMap(); drawCountyAnalysis();
  });

  $('run-moran').addEventListener('click', () => {
    const q = qualifying(), vals = new Map();
    q.forEach((c, f) => vals.set(f, c.mean));
    $('moran-out').textContent = 'Running 999 permutations…';
    setTimeout(() => {
      const m = Stats.moransI(vals, S.neighbors, 999);
      $('moran-out').innerHTML = m.error ? `<span class="warn">${esc(m.error)}</span>` :
        `I = <b>${fmt(m.I)}</b> (expected ${fmt(m.expected)} with no clustering), permutation p = <b>${fmtP(m.p)}</b>, ${m.n} counties sharing a border with another county at n ≥ ${minN()}` +
        (m.excluded ? `; ${m.excluded} isolated counties left out` : '') + '.';
    }, 20);
  });

  $('export-county').addEventListener('click', () => {
    const vars = S.wxVars.filter(v => S.wxOn.has(v));
    const sm = smoothed(), bw = $('bw').value;
    const lines = [['fips', 'county', 'state', 'n', 'mean_residual', `smoothed_residual_${bw}km`, 'smoothed_neff', ...vars].join(',')];
    const q = qualifying(), mn = minN();
    const ids = [...S.centroid.keys()].filter(f => q.has(f) || (sm.get(f) && sm.get(f).neff >= mn)).sort();
    ids.forEach(f => {
      const c = q.get(f), m = sm.get(f);
      lines.push([f, `"${S.countyName.get(f) || ''}"`, `"${S.stateName.get(f.slice(0, 2)) || ''}"`,
        c ? c.n : (S.county.get(f)?.n || 0), c ? c.mean.toFixed(5) : '',
        m && m.neff >= mn ? m.mean.toFixed(5) : '', m ? m.neff.toFixed(2) : '',
        ...vars.map(v => { const x = S.wx?.get(f)?.[v]; return x != null && isFinite(x) ? x : ''; })].join(','));
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `SPEER_counties_${S.fit.dv.replace(/\W+/g, '_')}_min${minN()}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  });

  // ---------------- county residuals vs weather ----------------
  $('scatter-x').addEventListener('change', drawCountyAnalysis);

  function drawCountyAnalysis() {
    const sc = d3.select('#scatter'); sc.selectAll('*').remove();
    const f = S.fit;
    if (!f) { $('county-summary').textContent = 'Fit a model first.'; $('county-table').innerHTML = ''; return; }
    const q = qualifying();
    if (!S.wx) {
      $('county-summary').innerHTML = `${q.size.toLocaleString()} counties have at least ${minN()} respondents. Load a county weather table in step 3 to compare.`;
      $('county-table').innerHTML = ''; return;
    }
    const xv = $('scatter-x').value;
    const pts = [...q].map(([id, c]) => ({ id, n: c.n, y: c.mean, x: S.wx.get(id)?.[xv] })).filter(p => p.x != null && isFinite(p.x));
    const W = 520, H = 340, m = { l: 52, r: 14, t: 14, b: 40 };
    const range = +$('range').value;
    const xs = d3.scaleLinear().domain(xv ? wxDomain(xv) : [0, 1]).nice().range([m.l, W - m.r]);
    const ys = d3.scaleLinear().domain([-range, range]).range([H - m.b, m.t]);
    const rs = d3.scaleSqrt().domain([1, 100]).range([2, 10]).clamp(true);
    sc.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(xs).ticks(6));
    sc.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(ys).ticks(6));
    sc.append('line').attr('class', 'zero').attr('x1', m.l).attr('x2', W - m.r).attr('y1', ys(0)).attr('y2', ys(0));
    sc.append('text').attr('class', 'label').attr('x', (m.l + W - m.r) / 2).attr('y', H - 6).attr('text-anchor', 'middle').text(xv || '');
    sc.append('text').attr('class', 'label').attr('transform', `translate(13,${(m.t + H - m.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle').text('County mean residual');
    const clip = v => Math.max(-range, Math.min(range, v));
    sc.append('g').selectAll('circle').data(pts).join('circle').attr('class', 'dot')
      .attr('cx', p => xs(p.x)).attr('cy', p => ys(clip(p.y))).attr('r', p => rs(p.n))
      .append('title').text(p => `${S.countyName.get(p.id) || p.id}: n=${p.n}, residual ${fmt(p.y)}, ${xv} ${fmt(p.x, 2)}`);

    // one-variable line for the plotted variable, weighted by respondents
    if (pts.length > 3) {
      const lr = Stats.ols(pts.map(p => [1, p.x]), pts.map(p => p.y), pts.map(p => p.n));
      if (!lr.error) {
        const [a, b] = xs.domain();
        sc.append('line').attr('class', 'fit').attr('x1', xs(a)).attr('x2', xs(b))
          .attr('y1', ys(clip(lr.beta[0] + lr.beta[1] * a))).attr('y2', ys(clip(lr.beta[0] + lr.beta[1] * b)));
      }
    }

    // county-level model on all ticked weather variables
    const vars = S.wxVars.filter(v => S.wxOn.has(v));
    const inModel = f.useWx.length ? ` <span class="warn">The respondent model already includes ${f.useWx.length} weather variable${f.useWx.length > 1 ? 's' : ''}, so these residuals are what remains after them.</span>` : '';
    if (!vars.length) {
      $('county-summary').innerHTML = `${pts.length.toLocaleString()} counties plotted (n ≥ ${minN()}). Dot area follows the number of respondents; the line is a respondent-weighted fit.` +
        ' Tick weather variables in step 3 to fit a county-level model.' + inModel;
      $('county-table').innerHTML = ''; return;
    }
    const rows = [...q].map(([id, c]) => ({ id, c, xs: vars.map(v => S.wx.get(id)?.[v]) })).filter(r => r.xs.every(v => v != null && isFinite(v)));
    const res = Stats.ols(rows.map(r => [1, ...r.xs]), rows.map(r => r.c.mean), rows.map(r => r.c.n));
    if (res.error) { $('county-summary').innerHTML = `<span class="err">${esc(res.error)}</span>`; $('county-table').innerHTML = ''; return; }
    $('county-summary').innerHTML = `County model: mean residual regressed on ${vars.length} weather variable${vars.length > 1 ? 's' : ''}, weighted by respondents. ` +
      `<b>${res.n.toLocaleString()}</b> counties with n ≥ ${minN()}, R² = <b>${fmt(res.r2)}</b>. Robust (HC1) standard errors. Dots show the plotted variable only.` + inModel;
    const names = ['(Intercept)', ...vars];
    $('county-table').innerHTML = `<div class="table-scroll"><table><thead><tr><th>Term</th><th class="num">Estimate</th><th class="num">SE</th><th class="num">t</th><th class="num">p</th></tr></thead><tbody>` +
      names.map((nm, j) => `<tr class="${res.p[j] < 0.05 && j > 0 ? 'sig' : ''}"><td>${esc(nm)}</td><td class="num">${fmt(res.beta[j], 4)}</td><td class="num">${fmt(res.se[j], 4)}</td><td class="num">${fmt(res.stat[j], 2)}</td><td class="num">${fmtP(res.p[j])}</td></tr>`).join('') +
      '</tbody></table></div>';
  }

  // ---------------- tabs ----------------
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
    document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
    if (name === 'shap') renderShapCands();
  }
  document.querySelector('.tabs').addEventListener('click', e => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

  // ---------------- outcome description ----------------
  function describeOutcome() {
    const dv = $('dv-col').value, g = d3.select('#dv-hist'); g.selectAll('*').remove();
    if (!dv || !S.rows.length) { $('dv-desc').textContent = 'Choose an outcome in step 4.'; return; }
    const miss = missingSet(), wt = $('wt-col').value;
    const vals = [], wts = [];
    S.rows.forEach(r => { if (isMissing(r[dv], miss)) return; const v = num(r[dv]); if (!isFinite(v)) return; vals.push(v); wts.push(wt ? (num(r[wt]) || 0) : 1); });
    if (!vals.length) { $('dv-desc').innerHTML = `<span class="warn">${esc(dv)} has no numeric answers.</span>`; return; }
    const sorted = vals.slice().sort((a, b) => a - b), n = vals.length;
    const mean = d3.mean(vals), sd = d3.deviation(vals) || 0;
    const sw = d3.sum(wts), wmean = sw ? d3.sum(vals.map((v, i) => v * wts[i])) / sw : NaN;
    const q = p => d3.quantileSorted(sorted, p);
    $('dv-desc').innerHTML = `<b>${esc(labelOf(dv))}</b>: n = ${n.toLocaleString()}, mean ${fmt(mean)}` + (wt ? ` (weighted ${fmt(wmean)})` : '') +
      `, SD ${fmt(sd)}, min ${fmt(sorted[0], 2)}, quartiles ${fmt(q(.25), 2)} / ${fmt(q(.5), 2)} / ${fmt(q(.75), 2)}, max ${fmt(sorted[n - 1], 2)}.`;
    const distinct = [...new Set(vals)].sort((a, b) => a - b);
    let bins;
    if (distinct.length <= 15) bins = distinct.map(v => ({ label: d3.format('~g')(v), n: vals.filter(x => x === v).length }));
    else {
      const b = d3.bin().thresholds(20)(vals);
      bins = b.map(bb => ({ label: d3.format('~g')(bb.x0), n: bb.length }));
    }
    const W = 420, H = 180, m = { l: 44, r: 8, t: 8, b: 30 };
    g.attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleBand().domain(bins.map((_, i) => i)).range([m.l, W - m.r]).padding(0.15);
    const y = d3.scaleLinear().domain([0, d3.max(bins, b => b.n)]).nice().range([H - m.b, m.t]);
    g.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4));
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat(i => bins[i].label).tickValues(bins.length > 12 ? x.domain().filter(i => i % 4 === 0) : x.domain()));
    g.selectAll('rect.bar').data(bins).join('rect').attr('x', (_, i) => x(i)).attr('width', x.bandwidth())
      .attr('y', b => y(b.n)).attr('height', b => y(0) - y(b.n)).attr('fill', '#0F5E66').attr('fill-opacity', 0.75)
      .append('title').text(b => `${b.label}: ${b.n}`);
  }
  $('dv-col').addEventListener('change', describeOutcome);
  $('wt-col').addEventListener('change', describeOutcome);

  // ---------------- interaction ----------------
  function fillInteractionMenus() {
    const cols = S.cols;
    const optsA = cols.map(c => `<option value="${esc(c)}">${esc(labelOf(c) !== c ? `${labelOf(c)} (${c})` : c)}</option>`).join('');
    const keepA = $('int-a').value, keepB = $('int-b').value;
    $('int-a').innerHTML = '<option value="">Choose</option>' + optsA;
    $('int-b').innerHTML = '<option value="">Choose</option>' + optsA;
    if (cols.includes(keepA)) $('int-a').value = keepA;
    if (cols.includes(keepB)) $('int-b').value = keepB;
  }

  $('int-fit').addEventListener('click', async () => {
    const A = $('int-a').value, B = $('int-b').value, out = $('int-summary');
    const bail = msg => {
      out.innerHTML = `<span class="err">${esc(msg)}</span>` + (/collinear/.test(msg) ? ' The moderator may duplicate predictors already in step 4 (for example Party3 alongside the Independent and Republican dummies); untick those and fit again.' : '');
      $('int-table').innerHTML = ''; d3.select('#int-plot').selectAll('*').remove(); $('toast').hidden = true;
    };
    if (!A || !B || A === B) return bail('Choose two different columns.');
    const set = modelSettings(); if (set.error) return bail(set.error + ' (step 4)');
    busy('Fitting the interaction model…'); await tick();
    const miss = missingSet();
    const ivs = set.ivs.filter(c => c !== A && c !== B);
    const base = termsFor(ivs, miss); if (base.error) return bail(base.error);
    const aTerms = termsFor([A], miss); if (aTerms.error) return bail(aTerms.error);
    const bVals = S.rows.map(r => isMissing(r[B], miss) ? NaN : num(r[B]));
    const bMean = d3.mean(bVals.filter(isFinite)), center = $('int-center').checked ? bMean : 0;
    const bName = labelOf(B) + (center ? ' (centered)' : '');
    const bTerm = { name: bName, get: (r, i) => isFinite(bVals[i]) ? bVals[i] - center : null };
    const prods = aTerms.map(t => ({ name: `${t.name} × ${bName}`, get: (r, i) => { const a = t.get(r, i); return a == null || !isFinite(bVals[i]) ? null : a * (bVals[i] - center); } }));
    const D = buildDesign(set, [...base, ...aTerms, bTerm, ...prods]); if (D.error) return bail(D.error);
    const res = runModel(set, D); if (res.error) return bail(res.error);
    const names = D.names, col = nm => names.indexOf(nm);
    const keyIdx = [...aTerms.map(t => col(t.name)), col(bName), ...prods.map(p => col(p.name))].filter(j => j >= 0);
    const f = { ...res, names };
    out.innerHTML = `${set.kind === 'logit' ? 'Logistic' : 'Linear'} model of <b>${esc(labelOf(set.dv))}</b> with ${ivs.length} other predictors held at their weighted means. n = <b>${res.n.toLocaleString()}</b>` +
      (set.kind === 'logit' ? `, McFadden pseudo R² = <b>${fmt(res.pseudoR2)}</b>.` : `, R² = <b>${fmt(res.r2)}</b>, adjusted R² = <b>${fmt(res.adjR2)}</b>.`) + ` Standard errors ${seText(res)}.` +
      (center ? ` ${esc(labelOf(B))} is centered on its mean (${fmt(center, 2)}).` : '');
    $('int-table').innerHTML = coefTableHTML(f, keyIdx) + '<p class="hint">Key terms only; the other predictors are in the model but not listed.</p>';

    // prediction lines: moderator levels (categories, 0/1, or mean ± 1 SD) across the range of B
    const w = set.wt ? D.w : D.X.map(() => 1), sw = d3.sum(w);
    const means = D.X[0].map((_, j) => d3.sum(D.X.map((r, i) => r[j] * w[i])) / sw);
    const aIdx = aTerms.map(t => col(t.name)), pIdx = prods.map(p => col(p.name)), bIdx = col(bName);
    const bUsed = D.idx.map(i => bVals[i]);
    const bLo = d3.min(bUsed), bHi = d3.max(bUsed);
    let lines;
    const isCat = S.ivKind[A] !== 'number';
    if (isCat) {
      const ref = aTerms[0] ? aTerms[0].name.match(/\(vs (.*)\)$/)[1] : '';
      lines = [{ label: `${labelOf(A)} = ${ref}`, a: aTerms.map(() => 0) }, ...aTerms.map((t, k) => ({ label: `${labelOf(A)} = ${t.level}`, a: aTerms.map((_, kk) => kk === k ? 1 : 0) }))];
    } else {
      const aUsed = D.idx.map(i => aTerms[0].get(S.rows[i], i));
      const distinctA = [...new Set(aUsed)];
      if (distinctA.length === 2 && distinctA.every(v => v === 0 || v === 1)) lines = [0, 1].map(v => ({ label: `${labelOf(A)} = ${v}`, a: [v] }));
      else { const m = d3.mean(aUsed), sd = d3.deviation(aUsed); lines = [[-1, 'mean − 1 SD'], [0, 'mean'], [1, 'mean + 1 SD']].map(([k, l]) => ({ label: `${labelOf(A)} ${l}`, a: [m + k * sd] })); }
    }
    const grid = d3.range(0, 41).map(i => bLo + (bHi - bLo) * i / 40);
    const crit = set.kind === 'logit' ? 1.96 : Stats.crit95(res.df);
    const inv = set.kind === 'logit' ? (e => 1 / (1 + Math.exp(-e))) : (e => e);
    lines.forEach(L => {
      L.pts = grid.map(bv => {
        const x = means.slice();
        aIdx.forEach((j, k) => { if (j >= 0) x[j] = L.a[k]; });
        if (bIdx >= 0) x[bIdx] = bv - center;
        pIdx.forEach((j, k) => { if (j >= 0) x[j] = L.a[k] * (bv - center); });
        const p = Stats.predict(x, res.beta, res.V);
        return { b: bv, y: inv(p.eta), lo: inv(p.eta - crit * p.se), hi: inv(p.eta + crit * p.se) };
      });
    });
    drawInteraction(lines, labelOf(B), set);
    done('Interaction model fitted.');
  });

  const LINE_COLORS = ['#0F5E66', '#A33A2E', '#E8934A', '#3E7CB8', '#5AAE61', '#7B5EA7'];
  function drawInteraction(lines, bLabel, set) {
    const g = d3.select('#int-plot'); g.selectAll('*').remove();
    const W = 620, H = 360, m = { l: 56, r: 170, t: 12, b: 44 };
    g.attr('viewBox', `0 0 ${W} ${H}`);
    const all = lines.flatMap(L => L.pts);
    const x = d3.scaleLinear().domain(d3.extent(all, p => p.b)).range([m.l, W - m.r]);
    const yDom = set.kind === 'logit' ? [0, 1] : d3.extent(all.flatMap(p => [p.lo, p.hi]));
    const y = d3.scaleLinear().domain(yDom).nice().range([H - m.b, m.t]);
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(7));
    g.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6));
    g.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', H - 8).attr('text-anchor', 'middle').text(bLabel);
    g.append('text').attr('transform', `translate(14,${(m.t + H - m.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle')
      .text(set.kind === 'logit' ? `Predicted probability, ${labelOf(set.dv)}` : `Predicted ${labelOf(set.dv)}`);
    lines.forEach((L, k) => {
      const c = LINE_COLORS[k % LINE_COLORS.length];
      g.append('path').attr('d', d3.area().x(p => x(p.b)).y0(p => y(p.lo)).y1(p => y(p.hi))(L.pts)).attr('fill', c).attr('fill-opacity', 0.12);
      g.append('path').attr('d', d3.line().x(p => x(p.b)).y(p => y(p.y))(L.pts)).attr('fill', 'none').attr('stroke', c).attr('stroke-width', 2.2);
      g.append('rect').attr('x', W - m.r + 12).attr('y', m.t + 8 + k * 20).attr('width', 14).attr('height', 3).attr('fill', c);
      g.append('text').attr('x', W - m.r + 32).attr('y', m.t + 13 + k * 20).text(L.label.length > 24 ? L.label.slice(0, 23) + '…' : L.label).append('title').text(L.label);
    });
    g.append('text').attr('x', W - m.r + 12).attr('y', m.t + 18 + lines.length * 20).attr('fill', '#56636B').text('Bands: 95% intervals');
  }

  // ---------------- group comparison ----------------
  const grpOn = new Set();
  function renderGroupItems() {
    const f = $('grp-filter').value.toLowerCase();
    $('grp-items').innerHTML = S.cols.filter(c => c.toLowerCase().includes(f) || labelOf(c).toLowerCase().includes(f))
      .map(c => `<label class="wx-row"><input type="checkbox" data-col="${esc(c)}" ${grpOn.has(c) ? 'checked' : ''}><span class="name">${esc(c)}${labelOf(c) !== c ? ` <span class="label">${esc(labelOf(c))}</span>` : ''}</span></label>`).join('');
  }
  $('grp-filter').addEventListener('input', renderGroupItems);
  $('grp-items').addEventListener('change', e => { const c = e.target.dataset.col; if (c) e.target.checked ? grpOn.add(c) : grpOn.delete(c); });

  function parseLabels(txt) {
    const m = new Map();
    txt.split(',').forEach(p => { const [k, ...v] = p.split('='); if (k && v.length) m.set(k.trim(), v.join('=').trim()); });
    return m;
  }
  let grpResult = null;
  $('grp-draw').addEventListener('click', () => {
    const by = $('grp-by').value, items = [...grpOn], out = $('grp-summary');
    if (!by || !items.length) { out.innerHTML = '<span class="err">Choose a grouping column and at least one item.</span>'; return; }
    const cut = num($('grp-cut').value), ge = $('grp-op').value === '>=';
    if (!isFinite(cut)) { out.innerHTML = '<span class="err">The cut-off must be a number.</span>'; return; }
    const miss = missingSet(), wt = $('wt-col').value, labs = parseLabels($('grp-labels').value);
    const groups = new Map();
    S.rows.forEach(r => {
      if (isMissing(r[by], miss)) return;
      const gk = String(r[by]).trim();
      const w = wt ? num(r[wt]) : 1; if (!isFinite(w) || w <= 0) return;
      if (!groups.has(gk)) groups.set(gk, {});
      const G = groups.get(gk);
      items.forEach(it => {
        if (isMissing(r[it], miss)) return; const v = num(r[it]); if (!isFinite(v)) return;
        const o = G[it] || (G[it] = { sw: 0, fav: 0, n: 0 });
        o.sw += w; o.n++; if (ge ? v >= cut : v <= cut) o.fav += w;
      });
    });
    const keys = [...groups.keys()].sort((a, b) => (isFinite(a) && isFinite(b)) ? a - b : a.localeCompare(b));
    if (keys.length > 12) { out.innerHTML = `<span class="err">${esc(by)} has ${keys.length} groups; choose a column with 12 or fewer.</span>`; return; }
    grpResult = { by, items, keys, groups, labs, rule: `${ge ? '≥' : '≤'} ${cut}` };
    out.textContent = `Percent with answers ${grpResult.rule}${wt ? ', weighted' : ', unweighted'}. Bars run from 0 to 100%.`;
    drawGroups(); $('export-grp').disabled = false;
  });

  // party labels get the usual party colors; other groups use the line palette
  const PARTY = [[/^democrat/i, '#2C5D8A'], [/^republican/i, '#A33A2E'], [/^independent/i, '#8C969C']];
  const groupColor = (label, i) => (PARTY.find(([re]) => re.test(label || '')) || [null, LINE_COLORS[i % LINE_COLORS.length]])[1];
  function drawGroups() {
    const R = grpResult, g = d3.select('#grp-plot'); g.selectAll('*').remove();
    const bar = 16, gap = 14, W = 620, m = { l: 170, r: 60, t: 10, b: 40 };
    const H = m.t + R.items.length * (R.keys.length * bar + gap) + m.b + 20 * Math.ceil(R.keys.length / 3);
    g.attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleLinear().domain([0, 100]).range([m.l, W - m.r]);
    const bottom = H - m.b - 20 * Math.ceil(R.keys.length / 3);
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${bottom})`).call(d3.axisBottom(x).ticks(5).tickFormat(d => d + '%'));
    R.items.forEach((it, ii) => {
      const y0 = m.t + ii * (R.keys.length * bar + gap);
      g.append('text').attr('x', m.l - 8).attr('y', y0 + R.keys.length * bar / 2 + 4).attr('text-anchor', 'end').text(labelOf(it));
      R.keys.forEach((k, ki) => {
        const o = R.groups.get(k)[it]; if (!o || !o.sw) return;
        const pct = 100 * o.fav / o.sw, c = groupColor(R.labs.get(k), ki);
        g.append('rect').attr('x', x(0)).attr('y', y0 + ki * bar).attr('width', x(pct) - x(0)).attr('height', bar - 2).attr('fill', c).attr('fill-opacity', 0.85)
          .append('title').text(`${R.labs.get(k) || k}: ${pct.toFixed(1)}% (n = ${o.n})`);
        g.append('text').attr('x', x(pct) + 4).attr('y', y0 + ki * bar + bar - 5).text(`${pct.toFixed(1)}%`);
      });
    });
    R.keys.forEach((k, ki) => {
      const lx = m.l + (ki % 3) * 140, ly = bottom + 30 + Math.floor(ki / 3) * 18;
      g.append('rect').attr('x', lx).attr('y', ly).attr('width', 12).attr('height', 10).attr('fill', groupColor(R.labs.get(k), ki));
      g.append('text').attr('x', lx + 16).attr('y', ly + 9).text(R.labs.get(k) || `${R.by} = ${k}`);
    });
  }
  $('export-grp').addEventListener('click', () => {
    const R = grpResult; if (!R) return;
    const lines = ['item,group,group_label,percent_favorable,n'];
    R.items.forEach(it => R.keys.forEach(k => { const o = R.groups.get(k)[it]; if (o && o.sw) lines.push([it, k, `"${R.labs.get(k) || ''}"`, (100 * o.fav / o.sw).toFixed(2), o.n].join(',')); }));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `SPEER_groups_${R.by.replace(/\W+/g, '_')}.csv`; a.click(); URL.revokeObjectURL(a.href);
  });

  // ---------------- correlations ----------------
  const CORR = d3.interpolateRgbBasis(['#2C5D8A', '#9DB8CF', '#F4F4F2', '#D9A193', '#A33A2E']);
  $('corr-draw').addEventListener('click', () => {
    const dv = $('dv-col').value, cols = [...(dv ? [dv] : []), ...[...S.ivOn].filter(c => S.cols.includes(c) && c !== dv)];
    const g = d3.select('#corr'); g.selectAll('*').remove();
    if (cols.length < 2) { $('corr-summary').innerHTML = '<span class="err">Choose an outcome and predictors in step 4 first.</span>'; return; }
    const miss = missingSet();
    const M = [];
    S.rows.forEach(r => { const v = cols.map(c => isMissing(r[c], miss) ? NaN : num(r[c])); if (v.every(isFinite)) M.push(v); });
    const k = cols.length, R = cols.map(() => new Array(k).fill(NaN));
    const mu = cols.map((_, j) => d3.mean(M, r => r[j])), sd = cols.map((_, j) => d3.deviation(M, r => r[j]));
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) R[a][b] = d3.sum(M, r => (r[a] - mu[a]) * (r[b] - mu[b])) / ((M.length - 1) * sd[a] * sd[b]);
    $('corr-summary').textContent = `${M.length.toLocaleString()} complete rows. Colors run from −1 (blue) to +1 (red).`;
    const cell = 26, lab = 170, W = lab + k * cell + 10, H = lab + k * cell + 10;
    g.attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`);
    cols.forEach((c, a) => {
      g.append('text').attr('x', lab - 6).attr('y', lab + a * cell + cell / 2 + 4).attr('text-anchor', 'end').text(labelOf(c));
      g.append('text').attr('transform', `translate(${lab + a * cell + cell / 2 + 4},${lab - 6}) rotate(-60)`).text(labelOf(c));
      cols.forEach((_, b) => {
        if (b > a) return;
        const v = R[a][b];
        g.append('rect').attr('x', lab + b * cell).attr('y', lab + a * cell).attr('width', cell - 1).attr('height', cell - 1)
          .attr('fill', isFinite(v) ? CORR((v + 1) / 2) : '#EEE').append('title').text(`${labelOf(cols[a])} × ${labelOf(cols[b])}: ${fmt(v, 2)}`);
        if (isFinite(v)) g.append('text').attr('x', lab + b * cell + cell / 2).attr('y', lab + a * cell + cell / 2 + 4).attr('text-anchor', 'middle')
          .attr('font-size', 9).attr('fill', Math.abs(v) > 0.6 ? '#fff' : '#1B2429').text(Math.abs(v) < 0.05 ? '0.0' : v.toFixed(1));
      });
    });
  });

  // ---------------- computed columns ----------------
  function fillComputedMenus() {
    const o = S.cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('cc-a').innerHTML = o; $('cc-b').innerHTML = o;
  }
  $('cc-op').addEventListener('change', () => { $('cc-b-wrap').hidden = ['center', 'z'].includes($('cc-op').value); });
  $('cc-add').addEventListener('click', () => {
    const op = $('cc-op').value, A = $('cc-a').value, B = $('cc-b').value, name = $('cc-name').value.trim(), out = $('cc-status');
    if (!S.rows.length) { out.textContent = 'Load a survey first.'; return; }
    if (!name) { out.textContent = 'Give the new column a name.'; return; }
    if (S.cols.includes(name)) { out.textContent = `${name} already exists.`; return; }
    const miss = missingSet(), get = (r, c) => isMissing(r[c], miss) ? NaN : num(r[c]);
    let vals;
    if (op === 'center' || op === 'z') {
      const a = S.rows.map(r => get(r, A)), m = d3.mean(a.filter(isFinite)), sd = d3.deviation(a.filter(isFinite));
      vals = a.map(v => isFinite(v) ? (op === 'center' ? v - m : (v - m) / sd) : NaN);
    } else {
      vals = S.rows.map(r => { const a = get(r, A), b = get(r, B); return op === 'diff' ? a - b : op === 'sum' ? a + b : a * b; });
    }
    S.rows.forEach((r, i) => { r[name] = isFinite(vals[i]) ? String(+vals[i].toFixed(6)) : ''; });
    S.cols.push(name); S.ivKind[name] = 'number';
    const OPS = { diff: `${A} − ${B}`, sum: `${A} + ${B}`, prod: `${A} × ${B}`, center: `${A} mean-centered`, z: `${A} standardized` };
    out.textContent = `Added ${name} = ${OPS[op]} (${vals.filter(isFinite).length.toLocaleString()} values). It exists only in this browser tab.`;
    refreshColumnMenus();
  });

  function refreshColumnMenus() {
    const keep = id => $(id).value;
    const dv = keep('dv-col'), wt = keep('wt-col'), by = keep('grp-by');
    fillSelect($('dv-col'), S.cols, { none: 'Choose a column', pick: dv });
    fillSelect($('wt-col'), S.cols, { none: 'None (unweighted)', pick: wt });
    fillSelect($('grp-by'), S.cols, { none: 'Choose a column', pick: by });
    renderIvList(); fillInteractionMenus(); fillComputedMenus(); renderGroupItems(); renderShapCands();
  }

  // ---------------- Excel files ----------------
  function readExcel(file) {
    busy(`Reading ${file.name}…`);
    const fr = new FileReader();
    fr.onload = async () => {
      try {
        const wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        const seen = new Map();
        const head = (aoa[0] || []).map(h => { let n = String(h).trim(); const k = seen.get(n) || 0; seen.set(n, k + 1); return k ? `${n}_${k}` : n; });
        S.rows = aoa.slice(1).filter(r => r.some(v => v !== '' && v != null)).map(r => { const o = {}; head.forEach((h, j) => { o[h] = r[j] == null ? '' : String(r[j]); }); return o; });
        S.cols = head.filter(Boolean); S.fileName = file.name; S.fit = null;
        $('survey-status').textContent = `${file.name} (sheet ${wb.SheetNames[0]}): ${S.rows.length.toLocaleString()} rows, ${S.cols.length} columns`;
        await onSurveyLoaded();
      } catch (e) { fail(`Could not read ${file.name}: ${e.message}`); }
    };
    fr.readAsArrayBuffer(file);
  }

  // ---------------- SHAP ----------------
  const shapOn = new Set();
  let SH = null;                 // last SHAP result
  const LOWHIGH = d3.interpolateRgbBasis(['#2C5D8A', '#9DB8CF', '#D9A193', '#A33A2E']);

  function renderShapCands() {
    const f = $('shap-filter').value.toLowerCase();
    const inModel = new Set(S.ivOn), dv = $('dv-col').value, wt = $('wt-col').value;
    $('shap-cands').innerHTML = S.cols.filter(c => c !== dv && c !== wt && !($('shap-use-ivs').checked && inModel.has(c)) &&
      (c.toLowerCase().includes(f) || labelOf(c).toLowerCase().includes(f)))
      .map(c => `<label class="wx-row"><input type="checkbox" data-col="${esc(c)}" ${shapOn.has(c) ? 'checked' : ''}><span class="name">${esc(c)}${labelOf(c) !== c ? ` <span class="label">${esc(labelOf(c))}</span>` : ''}</span></label>`).join('');
  }
  $('shap-filter').addEventListener('input', renderShapCands);
  $('shap-use-ivs').addEventListener('change', renderShapCands);
  $('shap-cands').addEventListener('change', e => { const c = e.target.dataset.col; if (c) e.target.checked ? shapOn.add(c) : shapOn.delete(c); });

  const numIn = (id, lo, hi) => Math.min(hi, Math.max(lo, +$(id).value));

  function shapData() {
    const miss = missingSet(), target = $('shap-target').value, dv = $('dv-col').value, wt = $('wt-col').value;
    if (!dv) return { error: 'Choose an outcome in step 4.' };
    if (target === 'resid' && !S.fit) return { error: 'Fit the respondent model first; its residuals are the target.' };
    const inModel = new Set([...S.ivOn].filter(c => S.cols.includes(c) && c !== dv && c !== wt));
    const feats = [];
    if ($('shap-use-ivs').checked) inModel.forEach(c => feats.push({ col: c, name: labelOf(c), inModel: true }));
    shapOn.forEach(c => { if (!inModel.has(c) || !$('shap-use-ivs').checked) if (S.cols.includes(c) && c !== dv) feats.push({ col: c, name: labelOf(c), inModel: inModel.has(c) }); });
    if ($('shap-use-wx').checked && S.wx) S.wxVars.filter(v => S.wxOn.has(v)).forEach(v => feats.push({ wx: v, name: `[county] ${v}`, inModel: S.fit ? S.fit.useWx.includes(v) : false }));
    if (feats.length < 2) return { error: 'Choose at least two features.' };
    const residOf = new Map();
    if (target === 'resid') S.fit.idx.forEach((ri, k) => residOf.set(ri, S.fit.resid[k]));
    const X = [], y = [], w = [], rowIdx = [];
    let dropped = 0;
    S.rows.forEach((r, i) => {
      let yi;
      if (target === 'resid') { if (!residOf.has(i)) return; yi = residOf.get(i); }
      else { if (isMissing(r[dv], miss)) { dropped++; return; } yi = num(r[dv]); if (!isFinite(yi)) { dropped++; return; } }
      let wi = 1;
      if ($('shap-weights').checked && wt) { wi = num(r[wt]); if (!isFinite(wi) || wi <= 0) { dropped++; return; } }
      const x = [];
      for (const f of feats) {
        let v;
        if (f.wx) { v = S.wx.get(S.rowFips[i])?.[f.wx]; if (v == null) { dropped++; return; } }
        else { if (isMissing(r[f.col], miss)) { dropped++; return; } v = num(r[f.col]); }
        if (!isFinite(v)) { dropped++; return; }
        x.push(v);
      }
      X.push(x); y.push(yi); w.push(wi); rowIdx.push(i);
    });
    if (X.length < 50) return { error: `Only ${X.length} complete rows for these features. Text columns cannot be used as features.` };
    const m = w.reduce((s, v) => s + v, 0) / w.length;
    return { X, y, w: w.map(v => v / m), feats, rowIdx, dropped, target, dv };
  }

  $('shap-run').addEventListener('click', async () => {
    const out = $('shap-summary');
    const D = shapData(); if (D.error) { out.innerHTML = `<span class="err">${esc(D.error)}</span>`; return; }
    const opts = { nTrees: Math.round(numIn('shap-trees', 10, 2000)), depth: numIn('shap-depth', 1, 8), lr: numIn('shap-lr', 0.001, 1),
      subsample: numIn('shap-sub', 0.1, 1), minChildWeight: numIn('shap-mcw', 0, 1e6), lambda: numIn('shap-lambda', 0, 1e6) };
    const hold = numIn('shap-hold', 0, 0.5), runs = Math.round(numIn('shap-runs', 1, 10)), seed0 = Math.round(+$('shap-seed').value || 1);
    const n = D.X.length, M = D.feats.length, useW = $('shap-weights').checked && $('wt-col').value;
    const results = [];
    for (let r = 0; r < runs; r++) {
      const seed = seed0 + r, rand = Boost.rng(seed * 7919 + 13);
      const order = [...Array(n).keys()].map(i => [rand(), i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
      const nTest = Math.round(hold * n), test = new Set(order.slice(0, nTest));
      const tr = [...Array(n).keys()].filter(i => !test.has(i)), te = [...test];
      const pick = (arr, ids) => ids.map(i => arr[i]);
      const model = await Boost.fit(pick(D.X, tr), pick(D.y, tr), pick(D.w, tr), { ...opts, seed,
        onProgress: async fr => { busy(`Run ${r + 1} of ${runs}: fitting trees ${Math.round(fr * 100)}%…`); await tick(); } });
      const r2tr = Boost.r2(model, pick(D.X, tr), pick(D.y, tr), pick(D.w, tr));
      const r2te = te.length ? Boost.r2(model, pick(D.X, te), pick(D.y, te), pick(D.w, te)) : NaN;
      const phi = new Array(n);
      for (let i = 0; i < n; i++) {
        phi[i] = TreeShap.shapRow(model, D.X[i]).phi;
        if (i % 150 === 149) { busy(`Run ${r + 1} of ${runs}: SHAP values ${Math.round(100 * i / n)}%…`); await tick(); }
      }
      const sw = D.w.reduce((s, v) => s + v, 0);
      const imp = D.feats.map((_, j) => phi.reduce((s, p, i) => s + D.w[i] * Math.abs(p[j]), 0) / sw);
      results.push({ seed, model, r2tr, r2te, phi, imp, base: TreeShap.shapRow(model, D.X[0]).base });
    }
    SH = { D, opts, hold, runs, seed0, results, useW, inter: null, linR2: S.fit && S.fit.kind === 'ols' ? S.fit.r2 : null };
    const te = results.map(r => r.r2te).filter(isFinite), trn = results.map(r => r.r2tr);
    const fmtR = arr => arr.length > 1 ? `${fmt(d3.mean(arr))} (range ${fmt(d3.min(arr))} to ${fmt(d3.max(arr))})` : fmt(arr[0]);
    out.innerHTML = `Target: <b>${D.target === 'resid' ? `residuals of the ${S.fit.kind === 'logit' ? 'logistic' : 'linear'} model of ${esc(labelOf(D.dv))}` : esc(labelOf(D.dv))}</b>. ` +
      `${n.toLocaleString()} respondents, ${M} features, ${runs} run${runs > 1 ? `s (seeds ${seed0}–${seed0 + runs - 1})` : ` (seed ${seed0})`}. ` +
      `R² on the ${Math.round(hold * 100)}% holdout: <b>${te.length ? fmtR(te) : 'no holdout'}</b>; on the training rows: ${fmtR(trn)}.` +
      (SH.linR2 != null && D.target === 'outcome' ? ` The linear respondent model's R² is ${fmt(SH.linR2)} (in-sample).` : '') +
      (te.length && d3.mean(te) < 0.05 ? ` <span class="warn">The trees explain little of the target on held-out respondents, so these SHAP values describe a weak model.</span>` : '') +
      (useW ? ' Survey weights are used in fitting and in the mean absolute SHAP values.' : '');
    fillShapMenus(); drawShapBar(); drawSwarm(); drawDependence();
    $('shap-int-run').disabled = false; $('shap-export').disabled = false;
    d3.select('#shap-int').selectAll('*').remove(); $('shap-pairs').innerHTML = ''; $('shap-int-summary').textContent = '';
    done('SHAP values computed.');
  });

  function importanceOrder() {
    const M = SH.D.feats.length;
    const mean = [...Array(M).keys()].map(j => d3.mean(SH.results, r => r.imp[j]));
    return { mean, order: [...Array(M).keys()].sort((a, b) => mean[b] - mean[a]) };
  }

  function drawShapBar() {
    const g = d3.select('#shap-bar'); g.selectAll('*').remove();
    const { mean, order } = importanceOrder(), top = order.slice(0, 30), F = SH.D.feats;
    const row = 20, W = 620, m = { l: 190, r: 70, t: 8, b: 80 }, H = m.t + top.length * row + m.b;
    g.attr('viewBox', `0 0 ${W} ${H}`);
    const hi = d3.max(top, j => d3.max(SH.results, r => r.imp[j])) || 1;
    const x = d3.scaleLinear().domain([0, niceMax(hi)]).range([m.l, W - m.r]);
    const bottom = m.t + top.length * row;
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${bottom})`).call(d3.axisBottom(x).ticks(6));
    g.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', bottom + 30).attr('text-anchor', 'middle').text(`Mean |SHAP value| (${SH.D.target === 'resid' ? 'residual' : 'outcome'} units)`);
    top.forEach((j, i) => {
      const y = m.t + i * row, c = F[j].inModel ? '#0F5E66' : '#E8934A';
      g.append('rect').attr('x', x(0)).attr('y', y + 3).attr('width', x(mean[j]) - x(0)).attr('height', row - 6).attr('fill', c).attr('fill-opacity', 0.85)
        .append('title').text(`${F[j].name}: ${fmt(mean[j], 4)}`);
      if (SH.runs > 1) {
        const lo = d3.min(SH.results, r => r.imp[j]), hi2 = d3.max(SH.results, r => r.imp[j]), cy = y + row / 2;
        g.append('line').attr('x1', x(lo)).attr('x2', x(hi2)).attr('y1', cy).attr('y2', cy).attr('stroke', '#1B2429');
        [lo, hi2].forEach(v => g.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', cy - 4).attr('y2', cy + 4).attr('stroke', '#1B2429'));
      }
      g.append('text').attr('x', m.l - 8).attr('y', y + row / 2 + 4).attr('text-anchor', 'end').text(F[j].name.length > 30 ? F[j].name.slice(0, 29) + '…' : F[j].name).append('title').text(F[j].name);
    });
    [['#0F5E66', 'In the respondent model'], ['#E8934A', 'Candidate, not in the model']].forEach(([c, t], i) => {
      const lx = m.l + i * 200, ly = bottom + 44;
      g.append('rect').attr('x', lx).attr('y', ly).attr('width', 12).attr('height', 10).attr('fill', c);
      g.append('text').attr('x', lx + 16).attr('y', ly + 9).text(t);
    });
    if (SH.runs > 1) g.append('text').attr('x', m.l).attr('y', bottom + 20 + 50).attr('fill', '#56636B').text(`Whiskers: range across ${SH.runs} runs`);
  }

  // fixed SHAP axis shared by the swarm and dependence plots
  function shapLimit() {
    const r = SH.results[0];
    return niceMax(d3.quantile(r.phi.flat().map(Math.abs).sort((a, b) => a - b), 0.995) || 1);
  }

  function featureScale(j) {
    const vals = SH.D.X.map(x => x[j]);
    const lo = d3.quantile(vals.slice().sort((a, b) => a - b), 0.02), hi = d3.quantile(vals.slice().sort((a, b) => a - b), 0.98);
    return v => hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
  }

  function drawSwarm() {
    const g = d3.select('#shap-swarm'); g.selectAll('*').remove();
    const { order } = importanceOrder(), top = order.slice(0, 15), F = SH.D.feats, r0 = SH.results[0];
    const row = 26, W = 620, m = { l: 190, r: 70, t: 8, b: 60 }, H = m.t + top.length * row + m.b, lim = shapLimit();
    g.attr('viewBox', `0 0 ${W} ${H}`);
    const x = d3.scaleLinear().domain([-lim, lim]).range([m.l, W - m.r]), bottom = m.t + top.length * row;
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${bottom})`).call(d3.axisBottom(x).ticks(7));
    g.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', bottom + 30).attr('text-anchor', 'middle').text('SHAP value (effect on the model\'s prediction)');
    g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', m.t).attr('y2', bottom).attr('stroke', '#1B2429').attr('stroke-dasharray', '3 3');
    const rand = Boost.rng(99), n = SH.D.X.length, step = Math.max(1, Math.floor(n / 1000));
    top.forEach((j, i) => {
      const cy = m.t + i * row + row / 2, sc = featureScale(j);
      g.append('text').attr('x', m.l - 8).attr('y', cy + 4).attr('text-anchor', 'end').text(F[j].name.length > 30 ? F[j].name.slice(0, 29) + '…' : F[j].name);
      const pts = [];
      for (let k = 0; k < n; k += step) pts.push(k);
      g.append('g').selectAll('circle').data(pts).join('circle')
        .attr('cx', k => x(Math.max(-lim, Math.min(lim, r0.phi[k][j])))).attr('cy', () => cy + (rand() - 0.5) * (row - 8))
        .attr('r', 1.8).attr('fill', k => LOWHIGH(sc(SH.D.X[k][j]))).attr('fill-opacity', 0.7);
    });
    const defs = g.append('defs').append('linearGradient').attr('id', 'lowhigh');
    d3.range(0, 1.01, 0.25).forEach(t => defs.append('stop').attr('offset', t).attr('stop-color', LOWHIGH(t)));
    g.append('rect').attr('x', m.l).attr('y', bottom + 42).attr('width', 120).attr('height', 8).attr('fill', 'url(#lowhigh)');
    g.append('text').attr('x', m.l - 6).attr('y', bottom + 50).attr('text-anchor', 'end').text('Feature value: low');
    g.append('text').attr('x', m.l + 126).attr('y', bottom + 50).text('high');
    g.append('text').attr('x', W - m.r).attr('y', bottom + 50).attr('text-anchor', 'end').attr('fill', '#56636B').text(`Run 1 (seed ${r0.seed})${step > 1 ? `, 1 in ${step} respondents shown` : ''}`);
  }

  function fillShapMenus() {
    const { order } = importanceOrder(), F = SH.D.feats;
    const opts = order.map(j => `<option value="${j}">${esc(F[j].name)}</option>`).join('');
    $('shap-dep-x').innerHTML = opts;
    $('shap-dep-c').innerHTML = '<option value="-1">None</option>' + opts;
    $('shap-dep-c').value = order[1] != null ? String(order[1]) : '-1';
  }
  $('shap-dep-x').addEventListener('change', drawDependence);
  $('shap-dep-c').addEventListener('change', drawDependence);

  function drawDependence() {
    const g = d3.select('#shap-dep'); g.selectAll('*').remove();
    if (!SH) return;
    const j = +$('shap-dep-x').value, c = +$('shap-dep-c').value, F = SH.D.feats, r0 = SH.results[0], lim = shapLimit();
    const W = 620, H = 340, m = { l: 56, r: 150, t: 12, b: 44 };
    g.attr('viewBox', `0 0 ${W} ${H}`);
    const xs = SH.D.X.map(x => x[j]), distinct = new Set(xs).size, span = (d3.max(xs) - d3.min(xs)) || 1;
    const x = d3.scaleLinear().domain(d3.extent(xs)).nice().range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([-lim, lim]).range([H - m.b, m.t]);
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(7));
    g.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6));
    g.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', '#1B2429').attr('stroke-dasharray', '3 3');
    g.append('text').attr('x', (m.l + W - m.r) / 2).attr('y', H - 8).attr('text-anchor', 'middle').text(F[j].name);
    g.append('text').attr('transform', `translate(14,${(m.t + H - m.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle').text(`SHAP value for ${F[j].name}`);
    const rand = Boost.rng(5), jit = distinct <= 12 ? span * 0.025 : 0, sc = c >= 0 ? featureScale(c) : null;
    const n = xs.length, step = Math.max(1, Math.floor(n / 1500)), pts = [];
    for (let k = 0; k < n; k += step) pts.push(k);
    g.append('g').selectAll('circle').data(pts).join('circle')
      .attr('cx', k => x(xs[k] + (rand() - 0.5) * 2 * jit)).attr('cy', k => y(Math.max(-lim, Math.min(lim, r0.phi[k][j]))))
      .attr('r', 2.2).attr('fill', k => sc ? LOWHIGH(sc(SH.D.X[k][c])) : '#0F5E66').attr('fill-opacity', 0.65);
    if (sc) {
      const defs = g.append('defs').append('linearGradient').attr('id', 'lowhigh2').attr('x1', 0).attr('x2', 0).attr('y1', 1).attr('y2', 0);
      d3.range(0, 1.01, 0.25).forEach(t => defs.append('stop').attr('offset', t).attr('stop-color', LOWHIGH(t)));
      g.append('rect').attr('x', W - m.r + 16).attr('y', m.t + 20).attr('width', 10).attr('height', 120).attr('fill', 'url(#lowhigh2)');
      g.append('text').attr('x', W - m.r + 16).attr('y', m.t + 12).text(F[c].name.length > 22 ? F[c].name.slice(0, 21) + '…' : F[c].name);
      g.append('text').attr('x', W - m.r + 30).attr('y', m.t + 28).text('high');
      g.append('text').attr('x', W - m.r + 30).attr('y', m.t + 140).text('low');
    }
    if (jit) g.append('text').attr('x', W - m.r + 16).attr('y', H - m.b).attr('fill', '#56636B').text('x values jittered');
  }

  $('shap-int-run').addEventListener('click', async () => {
    if (!SH) return;
    const nS = Math.min(SH.D.X.length, Math.round(numIn('shap-int-n', 50, 3000))), M = SH.D.feats.length, model = SH.results[0].model;
    const rand = Boost.rng(SH.seed0 + 1000);
    const sample = [...Array(SH.D.X.length).keys()].map(i => [rand(), i]).sort((a, b) => a[0] - b[0]).slice(0, nS).map(p => p[1]);
    const A = Array.from({ length: M }, () => new Array(M).fill(0));
    let sw = 0;
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s], wi = SH.useW ? SH.D.w[i] : 1, I = TreeShap.interactionRow(model, SH.D.X[i]);
      for (let a = 0; a < M; a++) for (let b = 0; b < M; b++) A[a][b] += wi * Math.abs(I[a][b]);
      sw += wi;
      if (s % 10 === 9) { busy(`Interaction values ${Math.round(100 * s / sample.length)}%…`); await tick(); }
    }
    // off-diagonal entries doubled, as in shap's summary: each pair's effect is split between (a,b) and (b,a)
    for (let a = 0; a < M; a++) for (let b = 0; b < M; b++) A[a][b] = (a === b ? 1 : 2) * A[a][b] / sw;
    SH.inter = { A, nS };
    drawInteractionMatrix();
    done('Interaction values computed.');
  });

  function drawInteractionMatrix() {
    const g = d3.select('#shap-int'); g.selectAll('*').remove();
    const { A, nS } = SH.inter, F = SH.D.feats, { order } = importanceOrder(), top = order.slice(0, 15), k = top.length;
    const pairs = [];
    for (let a = 0; a < F.length; a++) for (let b = 0; b < a; b++) pairs.push({ a, b, v: A[a][b] });
    pairs.sort((p, q) => q.v - p.v);
    const maxOff = d3.max(pairs, p => p.v) || 1;
    $('shap-int-summary').textContent = `Mean absolute SHAP interaction values over ${nS.toLocaleString()} sampled respondents, run 1 (seed ${SH.results[0].seed}). The diagonal holds each feature's main effect; off-diagonal cells share one color scale, set by the largest pair.`;
    const cell = 26, lab = 170, W = lab + k * cell + 10, H = lab + k * cell + 10;
    g.attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`);
    const col = d3.interpolateRgbBasis(['#F4F4F2', '#8FB9B8', '#0F5E66', '#08343A']);
    top.forEach((ja, a) => {
      g.append('text').attr('x', lab - 6).attr('y', lab + a * cell + cell / 2 + 4).attr('text-anchor', 'end').text(F[ja].name.length > 24 ? F[ja].name.slice(0, 23) + '…' : F[ja].name);
      g.append('text').attr('transform', `translate(${lab + a * cell + cell / 2 + 4},${lab - 6}) rotate(-60)`).text(F[ja].name.length > 24 ? F[ja].name.slice(0, 23) + '…' : F[ja].name);
      top.forEach((jb, b) => {
        if (b > a) return;
        const v = A[ja][jb], diag = a === b;
        g.append('rect').attr('x', lab + b * cell).attr('y', lab + a * cell).attr('width', cell - 1).attr('height', cell - 1)
          .attr('fill', diag ? '#E6E9EA' : col(Math.min(1, v / maxOff)))
          .append('title').text(diag ? `${F[ja].name}, main effect: ${fmt(v, 4)}` : `${F[ja].name} × ${F[jb].name}: ${fmt(v, 4)}`);
      });
    });
    const top10 = pairs.slice(0, 10);
    $('shap-pairs').innerHTML = `<h3 class="sub">Strongest pairs</h3><div class="table-scroll"><table class="pairs"><thead><tr><th>Pair</th><th class="num">Mean |interaction|</th><th></th></tr></thead><tbody>` +
      top10.map((p, i) => `<tr><td>${esc(F[p.a].name)} × ${esc(F[p.b].name)}</td><td class="num">${fmt(p.v, 4)}</td><td><button type="button" data-dep="${i}">Dependence plot</button>${F[p.a].col && F[p.b].col ? `<button type="button" data-test="${i}">Test in Interaction tab</button>` : ''}</td></tr>`).join('') +
      '</tbody></table></div><p class="hint">Testing a pair fills in the Interaction tab with the two columns; the regression there gives the interaction coefficient and its test.</p>';
    $('shap-pairs').onclick = e => {
      const i = e.target.dataset.dep ?? e.target.dataset.test; if (i == null) return;
      const p = top10[+i];
      if (e.target.dataset.dep != null) { $('shap-dep-x').value = String(p.a); $('shap-dep-c').value = String(p.b); drawDependence(); $('shap-dep').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      else { fillInteractionMenus(); $('int-a').value = F[p.a].col; $('int-b').value = F[p.b].col; showTab('interaction'); $('int-summary').textContent = 'Columns filled in from the SHAP tab. Press Fit interaction.'; }
    };
  }

  $('shap-export').addEventListener('click', () => {
    if (!SH) return;
    const F = SH.D.feats, q = v => `"${String(v).replace(/"/g, '""')}"`, { mean, order } = importanceOrder();
    const lines = [['feature', 'column', 'in_respondent_model', 'mean_abs_shap', ...SH.results.map(r => `run_seed_${r.seed}`)].join(',')];
    order.forEach(j => lines.push([q(F[j].name), q(F[j].col || F[j].wx), F[j].inModel ? 1 : 0, mean[j], ...SH.results.map(r => r.imp[j])].join(',')));
    if (SH.inter) {
      lines.push('', ['feature_a', 'feature_b', 'mean_abs_interaction'].join(','));
      const { A } = SH.inter;
      for (let a = 0; a < F.length; a++) for (let b = 0; b < a; b++) lines.push([q(F[a].name), q(F[b].name), A[a][b]].join(','));
    }
    const o = SH.opts;
    lines.push('', q(`target: ${SH.D.target === 'resid' ? 'residuals of respondent model of ' : ''}${SH.D.dv}; n: ${SH.D.X.length}; trees: ${o.nTrees}; depth: ${o.depth}; learning rate: ${o.lr}; subsample: ${o.subsample}; min child weight: ${o.minChildWeight}; lambda: ${o.lambda}; holdout: ${SH.hold}; runs: ${SH.runs}; first seed: ${SH.seed0}; survey weights: ${SH.useW ? 'yes' : 'no'}; holdout R2 by run: ${SH.results.map(r => r.r2te.toFixed(4)).join(' ')}`));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `SPEER_SHAP_${SH.D.dv.replace(/\W+/g, '_')}${SH.D.target === 'resid' ? '_residuals' : ''}.csv`; a.click(); URL.revokeObjectURL(a.href);
  });

  // ---------------- start ----------------
  busy('Loading the county map…');
  const mapReady = initMap();
  mapReady.then(() => { $('toast').hidden = true; });
  placeRespondents();
  mapReady.then(loadDefaultWeather);
})();
