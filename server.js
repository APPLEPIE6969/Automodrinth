const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const PROJECT_SLUG         = 'aurelium';
const MODRINTH_URL         = `https://modrinth.com/plugin/${PROJECT_SLUG}`;
const API_BASE             = 'https://api.modrinth.com/v2';
const INTERVAL_MS          = 12000;
const DL_TIMEOUT           = 20000;
const PROXY_REFRESH_EVERY  = 25; // cycles between proxy pool refreshes

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
];

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.nl/',
  'https://modrinth.com/',
  'https://modrinth.com/plugins',
  'https://discord.com/',
  'https://www.reddit.com/r/admincraft/',
  '',
];

// ─────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────
const state = {
  views: 0, downloads: 0, dlFailed: 0, errors: 0, cycles: 0,
  startTime: Date.now(),
  lastView: null, lastDl: null, lastError: null,
  log: [], versions: [], projectData: null,
  proxyPool: [], proxyTested: 0, proxyWorking: 0,
  proxyRefreshing: false, lastProxyRefresh: null,
};

// ─────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────
function log(msg, type = 'info') {
  const entry = { ts: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 150) state.log.pop();
  console.log(`[${entry.ts.slice(11,19)}] [${type.toUpperCase().padEnd(4)}] ${msg}`);
}

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const randEl = arr => arr[Math.floor(Math.random() * arr.length)];
const jitter = (ms, pct = 0.25) => ms + (Math.random() - 0.5) * ms * pct;

function makeHeaders(extra = {}) {
  return {
    'User-Agent':      randEl(USER_AGENTS),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': randEl(['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'nl-NL,nl;q=0.8,en;q=0.7']),
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Referer':         randEl(REFERERS),
    'DNT':             '1',
    ...extra,
  };
}

// ─────────────────────────────────────────
//  FETCH HELPERS
// ─────────────────────────────────────────
async function directFetch(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(tid); return r;
  } catch(e) { clearTimeout(tid); throw e; }
}

// Route through an HTTP proxy — each proxy = different IP = counts as new download
async function proxyFetch(url, proxyHostPort, ms, opts = {}) {
  const proxyUrl = `http://${proxyHostPort}`;
  const agent    = new HttpsProxyAgent(proxyUrl);
  const ctrl     = new AbortController();
  const tid      = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, agent });
    clearTimeout(tid); return r;
  } catch(e) { clearTimeout(tid); throw e; }
}

// ─────────────────────────────────────────
//  PROXY POOL — fetch from multiple sources,
//  test them, keep the working ones
// ─────────────────────────────────────────
const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
];

async function fetchProxyCandidates() {
  const set = new Set();
  await Promise.allSettled(PROXY_SOURCES.map(async src => {
    try {
      const res = await directFetch(src, 8000, { headers: { 'User-Agent': 'curl/7.88.1' } });
      if (!res.ok) return;
      const text = await res.text();
      for (const line of text.split(/[\r\n]+/)) {
        const t = line.trim().split('#')[0].trim(); // strip comments
        if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(t)) set.add(t);
      }
    } catch(_) {}
  }));
  return [...set];
}

// Quick test: connect through proxy to httpbin and check we get a real response
async function testProxy(hostPort) {
  try {
    const agent = new HttpsProxyAgent(`http://${hostPort}`);
    const ctrl  = new AbortController();
    const tid   = setTimeout(() => ctrl.abort(), 6000);
    const res   = await fetch('http://httpbin.org/ip', { signal: ctrl.signal, agent });
    clearTimeout(tid);
    if (!res.ok) return false;
    const j = await res.json();
    return typeof j.origin === 'string';
  } catch(_) { return false; }
}

async function refreshProxyPool() {
  if (state.proxyRefreshing) return;
  state.proxyRefreshing = true;
  log('Fetching proxy candidates...', 'info');

  try {
    const candidates = await fetchProxyCandidates();
    log(`Got ${candidates.length} candidates — testing up to 80`, 'info');

    const pool     = candidates.sort(() => Math.random() - 0.5).slice(0, 80);
    const working  = [];
    const BATCH    = 15;

    for (let i = 0; i < pool.length && working.length < 35; i += BATCH) {
      const batch   = pool.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(hp => testProxy(hp).then(ok => ok ? hp : null)));
      working.push(...results.filter(Boolean));
    }

    state.proxyTested  = Math.min(pool.length, 80);
    state.proxyWorking = working.length;
    state.proxyPool    = working;
    state.lastProxyRefresh = new Date().toISOString();
    log(`Proxy pool: ${working.length} working IPs ready`, working.length > 0 ? 'ok' : 'warn');
  } catch(e) {
    log(`Proxy refresh error: ${e.message}`, 'err');
  }

  state.proxyRefreshing = false;
}

// Returns next proxy host:port, rotating round-robin
function nextProxy() {
  if (!state.proxyPool.length) return null;
  const p = state.proxyPool.shift();
  state.proxyPool.push(p); // move to back
  return p;
}

// ─────────────────────────────────────────
//  LOAD PROJECT + VERSIONS
// ─────────────────────────────────────────
async function loadVersions() {
  if (state.versions.length > 0) return;
  log('Loading project from Modrinth API...');
  const h = { 'User-Agent': 'AutoBot/1.0', 'Accept': 'application/json' };
  const [pr, vr] = await Promise.all([
    directFetch(`${API_BASE}/project/${PROJECT_SLUG}`, 10000, { headers: h }),
    directFetch(`${API_BASE}/project/${PROJECT_SLUG}/version`, 10000, { headers: h }),
  ]);
  if (!pr.ok) throw new Error(`Project API ${pr.status}`);
  state.projectData = await pr.json();
  const all = await vr.json();
  state.versions = all.filter(v => v.files?.length);
  log(`"${state.projectData.title}" — ${state.versions.length} versions`, 'ok');
}

// ─────────────────────────────────────────
//  REGISTER PAGE VIEW (Render's own IP)
// ─────────────────────────────────────────
async function registerView() {
  try {
    const res = await directFetch(MODRINTH_URL, 15000, { headers: makeHeaders(), redirect: 'follow' });
    const reader = res.body?.getReader();
    if (reader) {
      let b = 0;
      while (b < 32768) { const { done, value } = await reader.read(); if (done) break; b += value?.length || 0; }
      reader.cancel();
    }
    state.views++;
    state.lastView = new Date().toISOString();
    log(`View #${state.views} — ${res.status}`, 'ok');
    return true;
  } catch(e) {
    log(`View failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`, 'warn');
    return false;
  }
}

// ─────────────────────────────────────────
//  DOWNLOAD via rotating proxy IP
//  Modrinth deduplicates by IP — routing each
//  download through a different proxy means
//  every download is counted as unique
// ─────────────────────────────────────────
async function downloadFile() {
  if (!state.versions.length) { log('No versions', 'warn'); return false; }

  const ver     = randEl(state.versions);
  const file    = ver.files.find(f => f.primary) || ver.files[0];
  const fileUrl = file.url;
  const fname   = file.filename;
  const loader  = (ver.loaders        || ['unknown'])[0];
  const gameVer = (ver.game_versions  || ['?'])[0];

  log(`Download: ${fname} [${loader} ${gameVer}]`, 'dl');
  await sleep(jitter(1400, 0.5)); // simulate clicking download button

  const dlHeaders = {
    ...makeHeaders({ 'Accept': 'application/java-archive,application/octet-stream,*/*' }),
    'Referer': `https://modrinth.com/plugin/${PROJECT_SLUG}/version/${ver.version_number}`,
  };

  // ── Try via proxy (unique IP per download)
  const proxy = nextProxy();
  if (proxy) {
    try {
      log(`  via proxy ${proxy}`, 'dl');
      const res = await proxyFetch(fileUrl, proxy, DL_TIMEOUT, { method: 'GET', headers: dlHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 100) throw new Error(`Too small: ${buf.byteLength}b`);
      const sizeKB = Math.round(buf.byteLength / 1024);
      state.downloads++;
      state.lastDl = { filename: fname, loader, gameVer, version: ver.version_number, sizeKB, via: proxy, ts: new Date().toISOString() };
      log(`Download #${state.downloads} ✓ ${sizeKB}KB via ${proxy}`, 'ok');
      return true;
    } catch(e) {
      // This proxy is dead — remove it
      state.proxyPool = state.proxyPool.filter(p => p !== proxy);
      state.proxyWorking = state.proxyPool.length;
      log(`  Proxy ${proxy} dead (${e.name === 'AbortError' ? 'timeout' : e.message}) — removed`, 'warn');
    }
  } else {
    log('  No proxies in pool — direct fallback (may not count uniquely)', 'warn');
  }

  // ── Fallback: direct (same IP, may deduplicate)
  try {
    const res = await directFetch(fileUrl, DL_TIMEOUT, { method: 'GET', headers: dlHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 100) throw new Error(`Too small`);
    const sizeKB = Math.round(buf.byteLength / 1024);
    state.downloads++;
    state.lastDl = { filename: fname, loader, gameVer, version: ver.version_number, sizeKB, via: 'direct', ts: new Date().toISOString() };
    log(`Download #${state.downloads} ✓ ${sizeKB}KB (direct — may deduplicate)`, 'ok');
    return true;
  } catch(e) {
    state.dlFailed++;
    state.lastError = e.message;
    log(`Download FAILED: ${e.name === 'AbortError' ? 'timeout' : e.message}`, 'err');
    return false;
  }
}

// ─────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────
async function runCycle() {
  state.cycles++;
  log(`─── Cycle #${state.cycles} ───`);

  // Refresh proxy pool on first cycle and every N cycles after
  if (state.cycles === 1 || state.cycles % PROXY_REFRESH_EVERY === 0) {
    refreshProxyPool(); // don't await — runs in background
    if (state.cycles === 1) await sleep(3000); // wait a bit on first cycle for pool to populate
  }

  try {
    if (!state.versions.length) await loadVersions();
    await registerView();
    const readTime = 5000 + Math.random() * 9000;
    log(`Reading for ${(readTime/1000).toFixed(1)}s...`);
    await sleep(readTime);
    await downloadFile();
  } catch(e) {
    log(`Cycle error: ${e.message}`, 'err');
    state.errors++;
    state.lastError = e.message;
  }

  const next = jitter(INTERVAL_MS);
  log(`Next in ${(next/1000).toFixed(1)}s`);
  setTimeout(runCycle, next);
}

// ─────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  const up  = Math.floor((Date.now() - state.startTime) / 1000);
  const ups = `${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${up%60}s`;
  const fmt = n => n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n);

  const logHtml = state.log.map(e => {
    const c = {ok:'#00e87a',warn:'#ffaa44',err:'#ff5533',dl:'#88ddff',info:'#5a9a70'}[e.type]||'#5a9a70';
    return `<div style="border-bottom:1px solid #163020;padding:4px 0;font-size:.68rem;color:${c}">[${e.ts.slice(11,19)}] ${String(e.msg).replace(/</g,'&lt;')}</div>`;
  }).join('');

  const lastDl = state.lastDl
    ? `<b>${state.lastDl.filename}</b><br>${state.lastDl.loader.toUpperCase()} · ${state.lastDl.gameVer} · v${state.lastDl.version}<br>${state.lastDl.sizeKB}KB via ${state.lastDl.via}`
    : 'None yet';

  const pips = state.proxyPool.slice(0,60).map(() => '<span class="pip on"></span>').join('');

  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Modrinth Bot</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#070e09;color:#aaeec0;font-family:'Courier New',monospace;padding:20px;max-width:1100px;margin:0 auto}
  h1{color:#00e87a;letter-spacing:3px;font-size:1rem;text-shadow:0 0 12px #00e87a55;margin-bottom:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
  .card{background:#0b1a0e;border:1px solid #163020;border-radius:4px;padding:12px}
  .cl{font-size:.47rem;color:#3a6a44;letter-spacing:2px;text-transform:uppercase;margin-bottom:5px}
  .cv{font-size:1.3rem;font-weight:bold;color:#00e87a;text-shadow:0 0 10px #00e87a44}
  .cv.sm{font-size:.72rem;line-height:1.4}
  .sec{background:#0b1a0e;border:1px solid #163020;border-radius:4px;padding:12px;margin-bottom:10px}
  .st{font-size:.47rem;color:#2a5530;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px}
  .lw{max-height:380px;overflow-y:auto}
  .lw::-webkit-scrollbar{width:3px}
  .lw::-webkit-scrollbar-thumb{background:#1e3a24}
  .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#00e87a;margin-right:6px;animation:p 1.5s ease-in-out infinite;box-shadow:0 0 8px #00e87a55;vertical-align:middle}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.2}}
  .status{font-size:.58rem;color:#00e87a;display:flex;align-items:center;margin-bottom:12px}
  footer{margin-top:12px;font-size:.47rem;color:#253a28}
  .pip{width:8px;height:8px;border-radius:50%;background:#1e3a24;display:inline-block;margin:1px}
  .pip.on{background:#00e87a;box-shadow:0 0 4px #00e87a66}
</style></head><body>
<h1>MODRINTH AUTOBOT // ${PROJECT_SLUG}</h1>
<div class="status"><span class="dot"></span>RUNNING · ${ups} · Cycle #${state.cycles} · refreshes every 5s</div>
<div class="grid">
  <div class="card"><div class="cl">Views</div><div class="cv">${fmt(state.views)}</div></div>
  <div class="card"><div class="cl">Downloads</div><div class="cv">${fmt(state.downloads)}</div></div>
  <div class="card"><div class="cl">DL Failed</div><div class="cv" style="color:${state.dlFailed>0?'#ffaa44':'#00e87a'}">${state.dlFailed}</div></div>
  <div class="card"><div class="cl">Errors</div><div class="cv" style="color:${state.errors>0?'#ff5533':'#00e87a'}">${state.errors}</div></div>
  <div class="card"><div class="cl">Live Proxies</div><div class="cv">${state.proxyPool.length}</div></div>
  <div class="card"><div class="cl">Versions</div><div class="cv">${state.versions.length}</div></div>
</div>
<div class="sec">
  <div class="st">Proxy Pool — ${state.proxyPool.length} unique IPs (refreshes every ${PROXY_REFRESH_EVERY} cycles)</div>
  <div style="margin-bottom:6px">${pips || '<span style="color:#ffaa44;font-size:.6rem">Building proxy pool...</span>'}</div>
  ${state.lastProxyRefresh?`<div style="font-size:.5rem;color:#3a6a44">Last refresh: ${state.lastProxyRefresh.slice(0,19).replace('T',' ')} · ${state.proxyTested} tested · ${state.proxyWorking} passed</div>`:''}
</div>
<div class="sec"><div class="st">Last Download</div><div style="font-size:.72rem;color:#88ddff;line-height:1.8">${lastDl}</div></div>
<div class="sec"><div class="st">Activity Log</div><div class="lw">${logHtml}</div></div>
<footer>TARGET: ${MODRINTH_URL} · Every download routed through a different proxy IP · Render.com</footer>
</body></html>`);
});

app.get('/stats', (req, res) => res.json({
  views: state.views, downloads: state.downloads, dlFailed: state.dlFailed,
  errors: state.errors, cycles: state.cycles, proxyPool: state.proxyPool.length,
  uptime: Math.floor((Date.now()-state.startTime)/1000),
  lastDl: state.lastDl, lastView: state.lastView,
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => {
  log(`Port ${PORT} ready`, 'ok');
  setTimeout(runCycle, 1500);
});
