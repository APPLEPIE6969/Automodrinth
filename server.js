const express = require('express');
const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const PROJECT_SLUG = 'aurelium';
const MODRINTH_URL = `https://modrinth.com/plugin/${PROJECT_SLUG}`;
const API_BASE     = 'https://api.modrinth.com/v2';
const INTERVAL_MS  = 10000;   // 10 seconds between cycles
const DL_TIMEOUT   = 30000;   // 30s download timeout

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
];

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.nl/',
  'https://modrinth.com/',
  'https://modrinth.com/plugins',
  'https://discord.com/',
  'https://www.reddit.com/',
  '',
];

// ─────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────
const state = {
  views:      0,
  downloads:  0,
  errors:     0,
  startTime:  Date.now(),
  running:    true,
  lastView:   null,
  lastDl:     null,
  lastError:  null,
  log:        [],   // last 100 log entries
  versions:   [],
  projectData: null,
};

// ─────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────
function log(msg, type = 'info') {
  const entry = {
    ts:   new Date().toISOString(),
    msg,
    type, // info | ok | warn | err | dl
  };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  console.log(`[${entry.ts}] [${type.toUpperCase()}] ${msg}`);
}

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const randEl  = arr => arr[Math.floor(Math.random() * arr.length)];
const jitter  = ms => ms + (Math.random() - 0.5) * ms * 0.3; // ±15% jitter

function makeHeaders(extra = {}) {
  return {
    'User-Agent':      randEl(USER_AGENTS),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Referer':         randEl(REFERERS),
    'DNT':             '1',
    ...extra,
  };
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(tid);
    return res;
  } catch(e) {
    clearTimeout(tid);
    throw e;
  }
}

// ─────────────────────────────────────────
//  LOAD VERSIONS FROM API
// ─────────────────────────────────────────
async function loadVersions() {
  if (state.versions.length > 0) return; // cached
  log('Fetching version list from Modrinth API...');
  try {
    const [projRes, versRes] = await Promise.all([
      fetchWithTimeout(`${API_BASE}/project/${PROJECT_SLUG}`, 10000, {
        headers: { 'User-Agent': 'AutoBot/1.0', 'Accept': 'application/json' }
      }),
      fetchWithTimeout(`${API_BASE}/project/${PROJECT_SLUG}/version`, 10000, {
        headers: { 'User-Agent': 'AutoBot/1.0', 'Accept': 'application/json' }
      }),
    ]);

    if (!projRes.ok) throw new Error(`Project API: ${projRes.status}`);
    if (!versRes.ok) throw new Error(`Versions API: ${versRes.status}`);

    state.projectData = await projRes.json();
    const all = await versRes.json();
    state.versions = all.filter(v => v.files && v.files.length > 0);

    log(`Loaded "${state.projectData.title}" — ${state.versions.length} versions`, 'ok');
  } catch(e) {
    log(`API load failed: ${e.message}`, 'warn');
    throw e;
  }
}

// ─────────────────────────────────────────
//  REGISTER A PAGE VIEW
//  Direct hit to modrinth.com — no proxy needed
//  on the server side (no CORS restrictions!)
// ─────────────────────────────────────────
async function registerView() {
  const ua  = randEl(USER_AGENTS);
  const ref = randEl(REFERERS);

  try {
    const res = await fetchWithTimeout(MODRINTH_URL, 15000, {
      method: 'GET',
      headers: makeHeaders(),
      redirect: 'follow',
    });

    // Read just enough to register the hit, then discard
    const reader = res.body?.getReader();
    if (reader) {
      let bytes = 0;
      while (bytes < 32768) { // read up to 32KB to simulate partial page load
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.length || 0;
      }
      reader.cancel();
    }

    state.views++;
    state.lastView = new Date().toISOString();
    log(`View #${state.views} registered (${res.status}) — UA: ${ua.slice(0,40)}...`, 'ok');
    return true;
  } catch(e) {
    log(`View failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`, 'warn');
    return false;
  }
}

// ─────────────────────────────────────────
//  DOWNLOAD A RANDOM VERSION FILE
// ─────────────────────────────────────────
async function downloadFile() {
  if (!state.versions.length) {
    log('No versions to download', 'warn');
    return false;
  }

  const ver     = randEl(state.versions);
  const file    = ver.files.find(f => f.primary) || ver.files[0];
  const fileUrl = file.url;
  const fname   = file.filename;
  const loader  = (ver.loaders || ['unknown'])[0];
  const gameVer = (ver.game_versions || ['?'])[0];

  log(`Downloading: ${fname} [${loader} ${gameVer}] v${ver.version_number}`, 'dl');

  // Small human-like delay before downloading (simulates clicking the button)
  await sleep(jitter(1200));

  try {
    const res = await fetchWithTimeout(fileUrl, DL_TIMEOUT, {
      method:  'GET',
      headers: {
        ...makeHeaders({ 'Accept': 'application/java-archive,application/zip,application/octet-stream,*/*' }),
        'Referer': `https://modrinth.com/plugin/${PROJECT_SLUG}/version/${ver.version_number}`,
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Read entire file into memory, then discard — registers as a full download
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < 100) throw new Error(`Suspiciously small: ${buffer.byteLength} bytes`);

    const sizeKB = Math.round(buffer.byteLength / 1024);
    state.downloads++;
    state.lastDl = {
      filename: fname,
      loader,
      gameVer,
      version:  ver.version_number,
      sizeKB,
      ts: new Date().toISOString(),
    };

    log(`Download #${state.downloads} complete: ${fname} — ${sizeKB}KB (discarded)`, 'ok');
    return true;
  } catch(e) {
    const reason = e.name === 'AbortError' ? 'timeout' : e.message;
    log(`Download failed: ${reason}`, 'err');
    state.errors++;
    state.lastError = reason;
    return false;
  }
}

// ─────────────────────────────────────────
//  SIMULATE HUMAN READING TIME
//  (delay between view and download)
// ─────────────────────────────────────────
function humanReadDelay() {
  // Normally distributed around 8s, range 4-15s
  const base = 8000 + (Math.random() - 0.5) * 8000;
  return Math.max(4000, Math.min(15000, base));
}

// ─────────────────────────────────────────
//  MAIN BOT CYCLE
// ─────────────────────────────────────────
async function runCycle() {
  if (!state.running) return;

  log('─── Starting new cycle ───');

  try {
    // Ensure versions are loaded
    if (!state.versions.length) await loadVersions();

    // Step 1: View the page
    await registerView();

    // Step 2: Simulate reading (random delay)
    const readTime = humanReadDelay();
    log(`Simulating ${(readTime/1000).toFixed(1)}s read time...`);
    await sleep(readTime);

    // Step 3: Download a random version
    await downloadFile();

  } catch(e) {
    log(`Cycle error: ${e.message}`, 'err');
    state.errors++;
    state.lastError = e.message;
  }

  // Schedule next cycle with jitter (prevents patterns)
  const nextIn = jitter(INTERVAL_MS);
  log(`Next cycle in ${(nextIn/1000).toFixed(1)}s`);
  setTimeout(runCycle, nextIn);
}

// ─────────────────────────────────────────
//  EXPRESS WEB DASHBOARD
//  (Render requires binding to a port)
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  const uptime   = Math.floor((Date.now() - state.startTime) / 1000);
  const uptimeStr = `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${uptime%60}s`;
  const fmtNum   = n => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n);

  const logHtml = state.log.map(e => {
    const color = { ok:'#00e87a', warn:'#ffaa44', err:'#ff5533', dl:'#88ddff', info:'#5a9a70' }[e.type] || '#5a9a70';
    return `<div style="border-bottom:1px solid #163020;padding:4px 0;font-size:.7rem;color:${color}">[${e.ts.slice(11,19)}] ${e.msg.replace(/</g,'&lt;')}</div>`;
  }).join('');

  const lastDlHtml = state.lastDl
    ? `<b>${state.lastDl.filename}</b><br>${state.lastDl.loader.toUpperCase()} · ${state.lastDl.gameVer} · v${state.lastDl.version}<br>${state.lastDl.sizeKB}KB — ${state.lastDl.ts.slice(0,19).replace('T',' ')}`
    : 'None yet';

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Modrinth Bot Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#070e09;color:#aaeec0;font-family:'Courier New',monospace;padding:20px;}
  h1{color:#00e87a;letter-spacing:3px;font-size:1rem;text-shadow:0 0 12px #00e87a55;margin-bottom:16px;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;}
  .card{background:#0b1a0e;border:1px solid #163020;border-radius:4px;padding:14px;}
  .card-label{font-size:.5rem;color:#3a6a44;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;}
  .card-value{font-size:1.4rem;font-weight:bold;color:#00e87a;text-shadow:0 0 10px #00e87a44;}
  .card-value.sm{font-size:.8rem;}
  .section{background:#0b1a0e;border:1px solid #163020;border-radius:4px;padding:14px;margin-bottom:12px;}
  .section-title{font-size:.5rem;color:#2a5530;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px;}
  .log-wrap{max-height:400px;overflow-y:auto;}
  .log-wrap::-webkit-scrollbar{width:3px;}
  .log-wrap::-webkit-scrollbar-thumb{background:#1e3a24;}
  .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#00e87a;margin-right:6px;animation:pulse 1.5s ease-in-out infinite;box-shadow:0 0 8px #00e87a55;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
  .status{font-size:.6rem;color:#00e87a;display:flex;align-items:center;margin-bottom:16px;}
  footer{margin-top:16px;font-size:.5rem;color:#253a28;letter-spacing:1px;}
</style>
</head>
<body>
<h1>MODRINTH AUTOBOT // aurelium</h1>
<div class="status"><span class="dot"></span> RUNNING · Auto-refreshes every 5s · Uptime: ${uptimeStr}</div>
<div class="grid">
  <div class="card"><div class="card-label">Views Sent</div><div class="card-value">${fmtNum(state.views)}</div></div>
  <div class="card"><div class="card-label">Downloads</div><div class="card-value">${fmtNum(state.downloads)}</div></div>
  <div class="card"><div class="card-label">Errors</div><div class="card-value" style="color:${state.errors>0?'#ff5533':'#00e87a'}">${state.errors}</div></div>
  <div class="card"><div class="card-label">Versions Loaded</div><div class="card-value">${state.versions.length}</div></div>
  <div class="card"><div class="card-label">Last View</div><div class="card-value sm">${state.lastView ? state.lastView.slice(0,19).replace('T',' ') : '--'}</div></div>
  <div class="card"><div class="card-label">Interval</div><div class="card-value sm">${INTERVAL_MS/1000}s + jitter</div></div>
</div>
<div class="section">
  <div class="section-title">Last Download</div>
  <div style="font-size:.75rem;color:#88ddff;line-height:1.8">${lastDlHtml}</div>
</div>
<div class="section">
  <div class="section-title">Activity Log (last 100)</div>
  <div class="log-wrap">${logHtml}</div>
</div>
<footer>TARGET: ${MODRINTH_URL} · Server-side bot — no browser needed · Direct HTTP requests</footer>
</body>
</html>`);
});

// JSON API endpoint for programmatic access
app.get('/stats', (req, res) => {
  res.json({
    views:     state.views,
    downloads: state.downloads,
    errors:    state.errors,
    uptime:    Math.floor((Date.now() - state.startTime) / 1000),
    running:   state.running,
    lastView:  state.lastView,
    lastDl:    state.lastDl,
    versions:  state.versions.length,
  });
});

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  log(`Dashboard running on port ${PORT}`, 'ok');
  log(`Target: ${MODRINTH_URL}`, 'info');
  log('Starting bot loop...', 'info');

  // Small startup delay then kick off the loop
  setTimeout(runCycle, 2000);
});
