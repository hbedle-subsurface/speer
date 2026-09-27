// Speer: survey regression, county residual map, county weather comparison.
(() => {
  const $ = id => document.getElementById(id);
  const fmt = (v, d = 3) => (v == null || !isFinite(v)) ? '–' : (+v).toFixed(d);
  const fmtP = p => (p == null || !isFinite(p)) ? '–' : p < 0.001 ? '<0.001' : p.toFixed(3);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const S = {
    rows: [], cols: [], fileName: '',
    zipCounty: null,            // Map zip5 -> {fips, share, nCounties}
    rowFips: [],                // per-row county FIPS or null
    ivKind: {},                 // col -> 'number' | 'category'
    ivOn: new Set(),
    wx: null,                   // Map fips -> {var: value}
    wxVars: [], wxDesc: {}, wxOn: new Set(),
    fit: null,                  // last model result + bookkeeping
    county: new Map(),          // fips -> {n, sumW, mean}
    topo: null, countyName: new Map(), stateName: new Map(), neighbors: new Map(),
    moran: null,
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
    Papa.parse(file, {
      header: true, skipEmptyLines: true, dynamicTyping: false,
      complete: res => {
        S.rows = res.data; S.cols = res.meta.fields.filter(c => c !== '' && c != null);
        S.fileName = file.name;
        $('survey-status').textContent = `${file.name}: ${S.rows.length.toLocaleString()} rows, ${S.cols.length} columns`;
        onSurveyLoaded();
      },
      error: err => { $('survey-status').innerHTML = `<span class="err">Could not read the file: ${esc(err.message)}</span>`; },
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
    return t === '' || t.toUpperCase() === 'NA' || t.toUpperCase() === 'NAN' || miss.has(t);
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

  function onSurveyLoaded() {
    $('step-place').removeAttribute('data-locked');
    $('step-model').removeAttribute('data-locked');
    const guessLoc = S.cols.find(c => /zip/i.test(c)) || S.cols.find(c => /fips|county/i.test(c));
    fillSelect($('loc-col'), S.cols, { none: 'Choose a column', pick: guessLoc });
    if (guessLoc && !/zip/i.test(guessLoc)) document.querySelector('input[name=loc-kind][value=fips]').checked = true;
    fillSelect($('dv-col'), S.cols, { none: 'Choose a column' });
    fillSelect($('wt-col'), S.cols, { none: 'None (unweighted)', pick: S.cols.find(c => /^weight|wt$|_wt|weight_/i.test(c)) });
    S.ivOn.clear(); S.ivKind = {};
    refreshIvKinds();
    placeRespondents();
  }

  function refreshIvKinds() {
    const miss = missingSet();
    for (const c of S.cols) if (!S.ivKind[c]) S.ivKind[c] = guessKind(c, miss);
    renderIvList();
  }

  function renderIvList() {
    const f = $('iv-filter').value.toLowerCase();
    const dv = $('dv-col').value, loc = $('loc-col').value, wt = $('wt-col').value;
    $('iv-list').innerHTML = S.cols
      .filter(c => c !== dv && c !== loc && c !== wt && c.toLowerCase().includes(f))
      .map(c => `<div class="iv-row"><input type="checkbox" data-col="${esc(c)}" ${S.ivOn.has(c) ? 'checked' : ''} aria-label="Use ${esc(c)}">
        <span class="name" title="${esc(c)}">${esc(c)}</span>
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
        m.set(String(r.zip).padStart(5, '0'), { fips: String(r.county_fips).padStart(5, '0'), share: +r.land_share, nCounties: +r.n_counties }));
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

  async function placeRespondents() {
    const col = $('loc-col').value, kind = document.querySelector('input[name=loc-kind]:checked').value;
    const out = $('place-status');
    S.rowFips = new Array(S.rows.length).fill(null);
    if (!col) { out.textContent = 'Choose the column that holds each respondent\'s location.'; return; }
    let matched = 0, split = 0, bad = 0, unknown = 0;
    if (kind === 'zip') {
      const zc = await loadZipCounty();
      if (!zc) {
        out.innerHTML = '<span class="err">data/zip_county.csv was not found. Build it with scripts/build_zip_county.py (see the README), or switch to a county FIPS column.</span>';
        return;
      }
      S.rows.forEach((r, i) => {
        const z = cleanZip(r[col]);
        if (!z) { bad++; return; }
        const hit = zc.get(z);
        if (!hit) { unknown++; return; }
        S.rowFips[i] = hit.fips; matched++;
        if (hit.share < 0.9) split++;
      });
      out.innerHTML = `<b>${matched.toLocaleString()}</b> of ${S.rows.length.toLocaleString()} respondents placed in a county.` +
        (unknown ? ` ${unknown} ZIPs have no Census ZCTA (often PO box or business ZIPs).` : '') +
        (bad ? ` ${bad} blank or malformed.` : '') +
        (split ? ` <span class="warn">${split} live in ZIPs that cross a county line; each is assigned to the county holding most of the ZIP's land area.</span>` : '');
    } else {
      S.rows.forEach((r, i) => {
        const f = cleanFips(r[col]);
        if (!f) { bad++; return; }
        if (S.countyName.size && !S.countyName.has(f)) { unknown++; return; }
        S.rowFips[i] = f; matched++;
      });
      out.innerHTML = `<b>${matched.toLocaleString()}</b> of ${S.rows.length.toLocaleString()} respondents placed in a county.` +
        (unknown ? ` ${unknown} codes are not on the county map.` : '') + (bad ? ` ${bad} blank or malformed.` : '');
    }
    const counties = new Set(S.rowFips.filter(Boolean)).size;
    out.innerHTML += ` ${counties.toLocaleString()} counties represented.`;
    if (S.fit) aggregateCounties();
  }
  $('loc-col').addEventListener('change', () => { renderIvList(); placeRespondents(); });
  document.querySelectorAll('input[name=loc-kind]').forEach(r => r.addEventListener('change', placeRespondents));

  // ---------------- weather table ----------------
  async function loadDefaultWeather() {
    try {
      const txt = await (await fetch('data/county_weather.csv')).text();
      if (!/^fips/i.test(txt.trim())) throw new Error('missing');
      try {
        const dtxt = await (await fetch('data/county_weather_dictionary.csv')).text();
        if (/^variable/i.test(dtxt.trim()))
          Papa.parse(dtxt, { header: true, skipEmptyLines: true }).data.forEach(r => S.wxDesc[r.variable] = r.description);
      } catch (e) { /* dictionary optional */ }
      setWeather(Papa.parse(txt, { header: true, skipEmptyLines: true }), 'data/county_weather.csv');
    } catch (e) {
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
    layer.innerHTML = '<option value="resid">Mean residual</option><option value="n">Respondents</option>' +
      vars.map(v => `<option value="wx:${esc(v)}">${esc(v)}</option>`).join('');
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

  function fitModel() {
    const status = $('model-status');
    const dv = $('dv-col').value, wt = $('wt-col').value, kind = dvKind();
    const ivs = S.cols.filter(c => S.ivOn.has(c) && c !== dv && c !== wt);
    const useWx = $('add-weather').checked ? [...S.wxOn] : [];
    const cluster = $('se-kind').value === 'cluster';
    if (!dv) { status.innerHTML = '<span class="err">Choose an outcome column.</span>'; return; }
    if (!ivs.length && !useWx.length) { status.innerHTML = '<span class="err">Tick at least one predictor.</span>'; return; }
    const ones = new Set([...document.querySelectorAll('#dv-ones-list input:checked')].map(i => i.value));
    if (kind === 'logit' && !ones.size) { status.innerHTML = '<span class="err">Tick the answers that count as yes.</span>'; return; }
    if ($('add-weather').checked && !useWx.length) { status.innerHTML = '<span class="err">Tick weather variables in step 3, or untick “Add selected weather variables”.</span>'; return; }
    const needCounty = cluster || useWx.length > 0;
    const miss = missingSet();

    // reference level = most common answer among rows usable for this model
    const levels = {};
    for (const c of ivs) if (S.ivKind[c] === 'category') {
      const d = distinctValues(c, miss, 200);
      if (d.size > 60) { status.innerHTML = `<span class="err">${esc(c)} has more than 60 answers. Mark it as a number or leave it out.</span>`; return; }
      const sorted = [...d.entries()].sort((a, b) => b[1] - a[1]);
      levels[c] = { ref: sorted[0][0], others: sorted.slice(1).map(e => e[0]).sort((a, b) => (isFinite(a) && isFinite(b)) ? a - b : a.localeCompare(b)) };
    }
    const names = ['(Intercept)'];
    for (const c of ivs) {
      if (S.ivKind[c] === 'number') names.push(c);
      else levels[c].others.forEach(l => names.push(`${c}: ${l} (vs ${levels[c].ref})`));
    }
    useWx.forEach(v => names.push(`[county] ${v}`));

    const X = [], y = [], w = [], cl = [], idx = [];
    let dropped = 0, noCounty = 0;
    S.rows.forEach((r, i) => {
      const fips = S.rowFips[i];
      if (needCounty && !fips) { noCounty++; return; }
      if (isMissing(r[dv], miss)) { dropped++; return; }
      let yi;
      if (kind === 'logit') yi = ones.has(String(r[dv]).trim()) ? 1 : 0;
      else { yi = num(r[dv]); if (!isFinite(yi)) { dropped++; return; } }
      let wi = 1;
      if (wt) { wi = num(r[wt]); if (!isFinite(wi) || wi <= 0) { dropped++; return; } }
      const x = [1];
      for (const c of ivs) {
        const v = r[c];
        if (isMissing(v, miss)) { dropped++; return; }
        if (S.ivKind[c] === 'number') { const xv = num(v); if (!isFinite(xv)) { dropped++; return; } x.push(xv); }
        else { const t = String(v).trim(); levels[c].others.forEach(l => x.push(t === l ? 1 : 0)); }
      }
      for (const v of useWx) {
        const xv = S.wx.get(fips)?.[v];
        if (xv == null || !isFinite(xv)) { dropped++; return; }
        x.push(xv);
      }
      X.push(x); y.push(yi); w.push(wi); cl.push(fips); idx.push(i);
    });
    if (X.length < 10) { status.innerHTML = `<span class="err">Only ${X.length} complete rows. Check the missing codes and predictor types.</span>`; return; }

    // drop dummy columns that never vary in the complete rows
    const keep = names.map((_, j) => j === 0 || X.some(r => r[j] !== X[0][j]));
    const Xk = X.map(r => r.filter((_, j) => keep[j]));
    const namesK = names.filter((_, j) => keep[j]);

    const res = (kind === 'logit' ? Stats.logit : Stats.ols)(Xk, y, wt ? w : null, cluster ? cl : null);
    if (res.error) { status.innerHTML = `<span class="err">${esc(res.error)}</span>`; return; }

    S.fit = { ...res, names: namesK, idx, w: wt ? w : null, dv, kind, ivs, useWx, cluster, dropped, noCounty, residSD: Math.sqrt(res.resid.reduce((s, e) => s + e * e, 0) / res.resid.length) };
    status.innerHTML = `Fitted on <b>${res.n.toLocaleString()}</b> respondents.` +
      (dropped ? ` ${dropped.toLocaleString()} dropped for missing answers.` : '') +
      (noCounty ? ` ${noCounty.toLocaleString()} dropped with no county.` : '') +
      (res.kind === 'logit' && !res.converged ? ' <span class="warn">The logistic fit did not fully converge.</span>' : '');

    // fixed color range: set from the outcome type, then left to the slider
    const r0 = kind === 'logit' ? 0.5 : Math.max(0.05, Math.round(S.fit.residSD * 20) / 20);
    const rg = $('range'); rg.max = Math.max(3, r0 * 3); rg.step = kind === 'logit' ? 0.01 : 0.05; rg.value = r0;
    $('range-out').textContent = fmt(r0, 2);
    renderCoefTable();
    aggregateCounties();
  }

  function renderCoefTable() {
    const f = S.fit;
    const stat = f.kind === 'logit' ? 'z' : 't';
    $('model-summary').innerHTML =
      `${f.kind === 'logit' ? 'Logistic' : 'Linear'} model of <b>${esc(f.dv)}</b>. n = <b>${f.n.toLocaleString()}</b>. ` +
      (f.kind === 'logit' ? `McFadden pseudo R² = <b>${fmt(f.pseudoR2)}</b>. Coefficients are log-odds.` : `R² = <b>${fmt(f.r2)}</b>, adjusted <b>${fmt(f.adjR2)}</b>.`) +
      ` Standard errors ${f.clusters ? `clustered on ${f.clusters.toLocaleString()} counties` : 'robust (HC1)'}.` +
      (f.w ? ' Survey weights applied.' : ' Unweighted.');
    $('coef-table').innerHTML = `<div class="table-scroll"><table><thead><tr><th>Term</th><th class="num">Estimate</th><th class="num">SE</th><th class="num">${stat}</th><th class="num">p</th></tr></thead><tbody>` +
      f.names.map((nm, j) => `<tr class="${f.p[j] < 0.05 && j > 0 ? 'sig' : ''}"><td>${esc(nm)}</td><td class="num">${fmt(f.beta[j])}</td><td class="num">${fmt(f.se[j])}</td><td class="num">${fmt(f.stat[j], 2)}</td><td class="num">${fmtP(f.p[j])}</td></tr>`).join('') +
      '</tbody></table></div><p class="hint">Rows marked on the left have p &lt; 0.05.</p>';
  }

  // ---------------- county aggregation ----------------
  function aggregateCounties() {
    const f = S.fit; S.county = new Map(); S.moran = null; $('moran-out').textContent = '';
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
    const path = d3.geoPath();
    countyPaths = svg.append('g').selectAll('path')
      .data(topojson.feature(S.topo, S.topo.objects.counties).features)
      .join('path').attr('class', 'county').attr('d', path).attr('fill', '#E6E9EA');
    svg.append('path').attr('class', 'states').attr('d', path(topojson.mesh(S.topo, S.topo.objects.states, (a, b) => a !== b)));
    svg.append('path').attr('class', 'nation').attr('d', path(topojson.feature(S.topo, S.topo.objects.nation)));
    countyPaths.on('mousemove', showTip).on('mouseleave', hideTip);
    drawLegend();
  }

  function layer() { return $('map-layer').value; }

  function drawMap() {
    if (!countyPaths) return;
    const L = layer(), range = +$('range').value, mn = minN();
    $('range-wrap').style.visibility = L === 'resid' ? 'visible' : 'hidden';
    let fill;
    if (L === 'resid') {
      fill = id => { const c = S.county.get(id); return c && c.n >= mn ? RESID(0.5 + Math.max(-1, Math.min(1, c.mean / range)) / 2) : null; };
    } else if (L === 'n') {
      const s = d3.scaleLog().domain([1, 100]).clamp(true);
      fill = id => { const c = S.county.get(id); return c ? SEQ(s(c.n)) : null; };
    } else {
      const v = L.slice(3), dom = wxDomain(v);
      fill = id => { const x = S.wx?.get(id)?.[v]; return x != null && isFinite(x) ? SEQ(Math.max(0, Math.min(1, (x - dom[0]) / (dom[1] - dom[0] || 1)))) : null; };
    }
    countyPaths.attr('fill', d => fill(d.id) || (S.county.has(d.id) ? '#D5DADC' : '#E6E9EA'));
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
    if (L === 'resid') { const r = +$('range').value; interp = RESID; lo = -r; hi = r; title = S.fit?.kind === 'logit' ? 'Mean residual (observed minus predicted probability)' : 'Mean residual (observed minus predicted)'; }
    else if (L === 'n') { interp = SEQ; lo = 1; hi = 100; title = 'Respondents per county (log scale)'; }
    else { interp = SEQ; [lo, hi] = wxDomain(L.slice(3)); title = L.slice(3); }
    const defs = g.append('defs').append('linearGradient').attr('id', 'lg');
    d3.range(0, 1.01, 0.1).forEach(t => defs.append('stop').attr('offset', t).attr('stop-color', interp(t)));
    g.append('text').attr('x', x0).attr('y', 11).attr('font-size', 12).attr('fill', '#56636B').text(title);
    g.append('rect').attr('x', x0).attr('y', 16).attr('width', W).attr('height', 10).attr('fill', 'url(#lg)');
    const lab = v => Math.abs(v) >= 100 ? d3.format(',.0f')(v) : d3.format('.2~f')(v);
    [[lo, 'start', x0], [hi, 'end', x0 + W]].forEach(([v, a, x]) =>
      g.append('text').attr('x', x).attr('y', 40).attr('text-anchor', a).attr('font-size', 11).attr('fill', '#1B2429').text((L === 'resid' && v > 0 ? '+' : '') + lab(v)));
    if (L === 'resid') g.append('text').attr('x', x0 + W / 2).attr('y', 40).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', '#1B2429').text('0');
    g.append('rect').attr('x', x0 + W + 16).attr('y', 16).attr('width', 12).attr('height', 10).attr('fill', '#D5DADC');
    g.append('text').attr('x', x0 + W + 32).attr('y', 25).attr('font-size', 11).attr('fill', '#56636B').text('< min n');
  }

  function showTip(ev, d) {
    const tip = $('tip'), c = S.county.get(d.id);
    const st = S.stateName.get(d.id.slice(0, 2)) || '';
    let h = `<b>${esc(S.countyName.get(d.id) || d.id)}${st ? ', ' + esc(st) : ''}</b> (${d.id})<br>`;
    h += c ? `${c.n} respondent${c.n > 1 ? 's' : ''}, mean residual ${c.mean > 0 ? '+' : ''}${fmt(c.mean)}` : 'No fitted respondents';
    if (c && c.n < minN()) h += ' (below min n)';
    const L = layer();
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
    const lines = [['fips', 'county', 'state', 'n', 'mean_residual', ...vars].join(',')];
    qualifying().forEach((c, f) => lines.push([f, `"${S.countyName.get(f) || ''}"`, `"${S.stateName.get(f.slice(0, 2)) || ''}"`, c.n, c.mean.toFixed(5),
      ...vars.map(v => { const x = S.wx?.get(f)?.[v]; return x != null && isFinite(x) ? x : ''; })].join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `speer_counties_${S.fit.dv.replace(/\W+/g, '_')}_min${minN()}.csv`;
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

  // ---------------- start ----------------
  initMap().then(loadDefaultWeather);
})();
