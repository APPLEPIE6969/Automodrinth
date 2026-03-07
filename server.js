const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
//  PROJECTS — add more here anytime
// ─────────────────────────────────────────
const PROJECTS = [
  { slug: 'aurelium',     type: 'plugin', label: 'Aurelium'      },
  { slug: 'dune-striders', type: 'mod',   label: 'Dune Striders'  },
];

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const API_BASE            = 'https://api.modrinth.com/v2';
const INTERVAL_MS         = 13000;   // base interval per project loop
const DL_TIMEOUT          = 20000;
const PROXY_REFRESH_EVERY = 40;      // cycles between proxy pool refreshes

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
];

const REFERERS = [
  'https://www.google.com/',
  'https://www.google.nl/',
  'https://modrinth.com/',
  'https://modrinth.com/plugins',
  'https://modrinth.com/mods',
  'https://discord.com/',
  'https://www.reddit.com/r/admincraft/',
  'https://www.reddit.com/r/feedthebeast/',
  '',
];

// ─────────────────────────────────────────
//  SHARED PROXY POOL (used by all projects)
// ─────────────────────────────────────────
const proxy = {
  pool:         [],
  tested:       0,
  working:      0,
  refreshing:   false,
  lastRefresh:  null,
};

// ─────────────────────────────────────────
//  PER-PROJECT STATE
// ─────────────────────────────────────────
const projects = PROJECTS.map(p => ({
  ...p,
  url:       `https://modrinth.com/${p.type}/${p.slug}`,
  versions:  [],
  data:      null,
  cycles:    0,
  views:     0,
  downloads: 0,
  dlFailed:  0,
  errors:    0,
  lastView:  null,
  lastDl:    null,
  lastError: null,
}));

// Shared log
const globalLog = [];

// ─────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────
function log(msg, type = 'info', tag = '') {
  const entry = { ts: new Date().toISOString(), msg, type, tag };
  globalLog.unshift(entry);
  if (globalLog.length > 200) globalLog.pop();
  console.log(`[${entry.ts.slice(11,19)}] [${(tag||type).toUpperCase().padEnd(14)}] ${msg}`);
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

async function directFetch(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(tid); return r;
  } catch(e) { clearTimeout(tid); throw e; }
}

async function proxyFetch(url, hostPort, ms, opts = {}) {
  const agent = new HttpsProxyAgent(`http://${hostPort}`);
  const ctrl  = new AbortController();
  const tid   = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, agent });
    clearTimeout(tid); return r;
  } catch(e) { clearTimeout(tid); throw e; }
}

// ─────────────────────────────────────────
//  PROXY SOURCES — 49 sources
// ─────────────────────────────────────────
const PROXY_SOURCES = [
  // ProxyScrape
  'https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all',
  // GitHub lists
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTP_RAW.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt',
  'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-https.txt',
  'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
  'https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies_anonymous/http.txt',
  'https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt',
  'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/https/https.txt',
  'https://raw.githubusercontent.com/saisuiu/Lionkings-Http-Proxys-Proxies/main/free.txt',
  'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt',
  'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/https_proxies.txt',
  'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt',
  'https://raw.githubusercontent.com/yuceltoluyag/GoodProxy/main/raw.txt',
  'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt',
  'https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt',
  'https://raw.githubusercontent.com/elliottophellia/yakumo/master/results/http/global/http_checked.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/https.txt',
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://raw.githubusercontent.com/ObcbO/getproxy/master/file/http.txt',
  'https://raw.githubusercontent.com/TuanMinPay/live-proxy/master/http.txt',
  'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/im-razvan/proxy_list/main/http.txt',
  'https://raw.githubusercontent.com/casals-ar/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/casals-ar/proxy-list/main/https.txt',
  // Public API endpoints
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://www.proxy-list.download/api/v1/get?type=https',
  'https://www.proxyscan.io/download?type=http',
  'https://api.openproxylist.xyz/http.txt',
  'https://multiproxy.org/txt_all/proxy.txt',
];

async function fetchProxyCandidates() {
  const set = new Set();
  await Promise.allSettled(PROXY_SOURCES.map(async src => {
    try {
      const res = await directFetch(src, 8000, { headers: { 'User-Agent': 'curl/7.88.1' } });
      if (!res.ok) return;
      const text = await res.text();
      for (const line of text.split(/[\r\n]+/)) {
        const t = line.trim().split('#')[0].trim();
        if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(t)) set.add(t);
      }
    } catch(_) {}
  }));
  return [...set];
}

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
  if (proxy.refreshing) return;
  proxy.refreshing = true;
  log('Fetching proxy candidates from 49 sources...', 'info', 'PROXY');

  try {
    const candidates = await fetchProxyCandidates();
    log(`Got ${candidates.length} candidates — testing up to 200`, 'info', 'PROXY');

    const pool    = candidates.sort(() => Math.random() - 0.5).slice(0, 200);
    const working = [];
    const BATCH   = 15;

    for (let i = 0; i < pool.length && working.length < 80; i += BATCH) {
      const batch   = pool.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(hp => testProxy(hp).then(ok => ok ? hp : null)));
      working.push(...results.filter(Boolean));
    }

    proxy.tested     = Math.min(pool.length, 200);
    proxy.working    = working.length;
    proxy.pool       = working;
    proxy.lastRefresh = new Date().toISOString();
    log(`Proxy pool ready: ${working.length} working IPs`, working.length > 0 ? 'ok' : 'warn', 'PROXY');
  } catch(e) {
    log(`Proxy refresh error: ${e.message}`, 'err', 'PROXY');
  }

  proxy.refreshing = false;
}

function nextProxy() {
  if (!proxy.pool.length) return null;
  const p = proxy.pool.shift();
  proxy.pool.push(p);
  return p;
}

// ─────────────────────────────────────────
//  LOAD VERSIONS FOR A PROJECT
// ─────────────────────────────────────────
async function loadVersions(proj) {
  if (proj.versions.length > 0) return;
  log(`Loading ${proj.label} from API...`, 'info', proj.label);
  const h = { 'User-Agent': 'AutoBot/1.0', 'Accept': 'application/json' };
  const [pr, vr] = await Promise.all([
    directFetch(`${API_BASE}/project/${proj.slug}`, 10000, { headers: h }),
    directFetch(`${API_BASE}/project/${proj.slug}/version`, 10000, { headers: h }),
  ]);
  if (!pr.ok) throw new Error(`Project API ${pr.status}`);
  proj.data = await pr.json();
  const all = await vr.json();
  proj.versions = all.filter(v => v.files?.length);
  log(`"${proj.data.title}" — ${proj.versions.length} versions`, 'ok', proj.label);
}

// ─────────────────────────────────────────
//  REGISTER VIEW
// ─────────────────────────────────────────
async function registerView(proj) {
  try {
    const res = await directFetch(proj.url, 15000, { headers: makeHeaders(), redirect: 'follow' });
    const reader = res.body?.getReader();
    if (reader) {
      let b = 0;
      while (b < 32768) { const { done, value } = await reader.read(); if (done) break; b += value?.length || 0; }
      reader.cancel();
    }
    proj.views++;
    proj.lastView = new Date().toISOString();
    log(`View #${proj.views} registered (${res.status})`, 'ok', proj.label);
    return true;
  } catch(e) {
    log(`View failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`, 'warn', proj.label);
    return false;
  }
}

// ─────────────────────────────────────────
//  DOWNLOAD via rotating proxy
// ─────────────────────────────────────────
async function downloadFile(proj) {
  if (!proj.versions.length) { log('No versions', 'warn', proj.label); return false; }

  const ver     = randEl(proj.versions);
  const file    = ver.files.find(f => f.primary) || ver.files[0];
  const fileUrl = file.url;
  const fname   = file.filename;
  const loader  = (ver.loaders       || ['unknown'])[0];
  const gameVer = (ver.game_versions || ['?'])[0];

  log(`Download: ${fname} [${loader} ${gameVer}]`, 'dl', proj.label);
  await sleep(jitter(1400, 0.5));

  const dlHeaders = {
    ...makeHeaders({ 'Accept': 'application/java-archive,application/octet-stream,*/*' }),
    'Referer': `https://modrinth.com/${proj.type}/${proj.slug}/version/${ver.version_number}`,
  };

  // Try via proxy
  const hp = nextProxy();
  if (hp) {
    try {
      log(`  via ${hp}`, 'dl', proj.label);
      const res = await proxyFetch(fileUrl, hp, DL_TIMEOUT, { method: 'GET', headers: dlHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 100) throw new Error(`Too small: ${buf.byteLength}b`);
      const sizeKB = Math.round(buf.byteLength / 1024);
      proj.downloads++;
      proj.lastDl = { filename: fname, loader, gameVer, version: ver.version_number, sizeKB, via: hp, ts: new Date().toISOString() };
      log(`Download #${proj.downloads} ✓ ${sizeKB}KB via ${hp}`, 'ok', proj.label);
      return true;
    } catch(e) {
      proxy.pool = proxy.pool.filter(p => p !== hp);
      proxy.working = proxy.pool.length;
      log(`  Proxy ${hp} dead — removed (${e.name === 'AbortError' ? 'timeout' : e.message})`, 'warn', proj.label);
    }
  } else {
    log('  No proxies — direct fallback', 'warn', proj.label);
  }

  // Direct fallback
  try {
    const res = await directFetch(fileUrl, DL_TIMEOUT, { method: 'GET', headers: dlHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 100) throw new Error('Too small');
    const sizeKB = Math.round(buf.byteLength / 1024);
    proj.downloads++;
    proj.lastDl = { filename: fname, loader, gameVer, version: ver.version_number, sizeKB, via: 'direct', ts: new Date().toISOString() };
    log(`Download #${proj.downloads} ✓ ${sizeKB}KB (direct)`, 'ok', proj.label);
    return true;
  } catch(e) {
    proj.dlFailed++;
    proj.lastError = e.message;
    log(`Download FAILED: ${e.name === 'AbortError' ? 'timeout' : e.message}`, 'err', proj.label);
    return false;
  }
}

// ─────────────────────────────────────────
//  PER-PROJECT LOOP
//  Each project runs independently with its
//  own cycle counter and timing — they share
//  the proxy pool but don't block each other
// ─────────────────────────────────────────
async function runProjectCycle(proj) {
  proj.cycles++;

  // Proxy refresh is shared — only the first project triggers it
  if (proj === projects[0] && (proj.cycles === 1 || proj.cycles % PROXY_REFRESH_EVERY === 0)) {
    refreshProxyPool();
    if (proj.cycles === 1) await sleep(3000);
  }

  log(`─── Cycle #${proj.cycles} ───`, 'info', proj.label);

  try {
    if (!proj.versions.length) await loadVersions(proj);
    await registerView(proj);
    const readTime = 5000 + Math.random() * 9000;
    log(`Reading for ${(readTime/1000).toFixed(1)}s...`, 'info', proj.label);
    await sleep(readTime);
    await downloadFile(proj);
  } catch(e) {
    proj.errors++;
    proj.lastError = e.message;
    log(`Cycle error: ${e.message}`, 'err', proj.label);
  }

  // Stagger each project's next cycle slightly differently so they don't always fire together
  const next = jitter(INTERVAL_MS + proj.slug.length * 100);
  setTimeout(() => runProjectCycle(proj), next);
}

// ─────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  const up  = Math.floor((Date.now() - startTime) / 1000);
  const ups = `${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${up%60}s`;
  const fmt = n => n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n);

  const totalViews = projects.reduce((a,p) => a+p.views, 0);
  const totalDls   = projects.reduce((a,p) => a+p.downloads, 0);

  const projectCards = projects.map(p => {
    const lastDl = p.lastDl
      ? `<b>${p.lastDl.filename}</b><br><span style="color:#5a9a70">${p.lastDl.loader.toUpperCase()} · ${p.lastDl.gameVer} · v${p.lastDl.version} · ${p.lastDl.sizeKB}KB</span><br><span style="color:#3a6a44;font-size:.55rem">via ${p.lastDl.via}</span>`
      : '<span style="color:#3a6a44">Pending...</span>';
    return `
    <div class="pcard">
      <div class="ptitle">${p.label} <span class="pslug">/${p.type}/${p.slug}</span></div>
      <div class="pgrid">
        <div class="pstat"><div class="pl">Views</div><div class="pv">${fmt(p.views)}</div></div>
        <div class="pstat"><div class="pl">Downloads</div><div class="pv">${fmt(p.downloads)}</div></div>
        <div class="pstat"><div class="pl">DL Failed</div><div class="pv" style="color:${p.dlFailed>0?'#ffaa44':'#00e87a'}">${p.dlFailed}</div></div>
        <div class="pstat"><div class="pl">Cycles</div><div class="pv">${p.cycles}</div></div>
      </div>
      <div class="pdl"><div class="pl" style="margin-bottom:4px">Last Download</div><div style="font-size:.65rem;line-height:1.7;color:#88ddff">${lastDl}</div></div>
    </div>`;
  }).join('');

  const logHtml = globalLog.map(e => {
    const c = {ok:'#00e87a',warn:'#ffaa44',err:'#ff5533',dl:'#88ddff',info:'#5a9a70'}[e.type]||'#5a9a70';
    const tag = e.tag ? `<span style="color:#2a6a3a;margin-right:4px">[${e.tag}]</span>` : '';
    return `<div style="border-bottom:1px solid #0f2015;padding:4px 0;font-size:.65rem;color:${c}">[${e.ts.slice(11,19)}] ${tag}${String(e.msg).replace(/</g,'&lt;')}</div>`;
  }).join('');

  const pips = proxy.pool.slice(0, 80).map(() => '<span class="pip"></span>').join('');

  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Modrinth Bot</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#070e09;color:#aaeec0;font-family:'Courier New',monospace;padding:20px;max-width:1200px;margin:0 auto}
  h1{color:#00e87a;letter-spacing:3px;font-size:1rem;text-shadow:0 0 12px #00e87a55;margin-bottom:10px}
  .totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:14px}
  .tcard{background:#0b1a0e;border:1px solid #163020;border-radius:4px;padding:11px}
  .tl{font-size:.46rem;color:#3a6a44;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
  .tv{font-size:1.3rem;font-weight:bold;color:#00e87a;text-shadow:0 0 10px #00e87a44}
  .tv.sm{font-size:.7rem;line-height:1.4}
  .projects{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:10px;margin-bottom:12px}
  .pcard{background:#0b1a0e;border:1px solid #163020;border-radius:4px;padding:14px}
  .ptitle{font-size:.75rem;font-weight:bold;color:#c8f0d8;margin-bottom:10px;border-bottom:1px solid #163020;padding-bottom:6px}
  .pslug{font-size:.55rem;color:#3a6a44;font-weight:normal}
  .pgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px}
  .pstat{background:#080f0a;border:1px solid #0f2015;border-radius:3px;padding:7px}
  .pl{font-size:.44rem;color:#3a6a44;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px}
  .pv{font-size:1rem;font-weight:bold;color:#00e87a}
  .pdl{background:#080f0a;border:1px solid #0f2015;border-radius:3px;padding:8px}
  .sec{background:#0b1a0e;border:1px solid #163020;border-radius:4px;padding:12px;margin-bottom:10px}
  .st{font-size:.46rem;color:#2a5530;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px}
  .lw{max-height:360px;overflow-y:auto}
  .lw::-webkit-scrollbar{width:3px}
  .lw::-webkit-scrollbar-thumb{background:#1e3a24}
  .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#00e87a;margin-right:6px;animation:p 1.5s ease-in-out infinite;box-shadow:0 0 8px #00e87a55;vertical-align:middle}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.2}}
  .status{font-size:.57rem;color:#00e87a;display:flex;align-items:center;margin-bottom:12px}
  footer{margin-top:12px;font-size:.46rem;color:#253a28}
  .pip{width:8px;height:8px;border-radius:50%;background:#00e87a;box-shadow:0 0 4px #00e87a66;display:inline-block;margin:1px}
</style></head><body>
<h1>MODRINTH AUTOBOT — ${projects.length} PROJECTS RUNNING</h1>
<div class="status"><span class="dot"></span>RUNNING · Uptime: ${ups} · Auto-refresh: 5s · ${proxy.pool.length} proxy IPs live</div>

<div class="totals">
  <div class="tcard"><div class="tl">Total Views</div><div class="tv">${fmt(totalViews)}</div></div>
  <div class="tcard"><div class="tl">Total Downloads</div><div class="tv">${fmt(totalDls)}</div></div>
  <div class="tcard"><div class="tl">Projects</div><div class="tv">${projects.length}</div></div>
  <div class="tcard"><div class="tl">Proxy Pool</div><div class="tv">${proxy.pool.length}</div></div>
  <div class="tcard"><div class="tl">Proxies Tested</div><div class="tv sm">${proxy.tested} tested · ${proxy.working} passed</div></div>
</div>

<div class="projects">${projectCards}</div>

<div class="sec">
  <div class="st">Proxy Pool — ${proxy.pool.length} unique IPs (refreshes every ${PROXY_REFRESH_EVERY} cycles)</div>
  <div style="margin-bottom:5px">${pips || '<span style="color:#ffaa44;font-size:.6rem">Building proxy pool...</span>'}</div>
  ${proxy.lastRefresh ? `<div style="font-size:.48rem;color:#3a6a44">Last refresh: ${proxy.lastRefresh.slice(0,19).replace('T',' ')}</div>` : ''}
</div>

<div class="sec"><div class="st">Activity Log (all projects)</div><div class="lw">${logHtml}</div></div>
<footer>TARGETS: ${projects.map(p=>p.url).join(' · ')} · Proxy-rotated downloads · Render.com</footer>
</body></html>`);
});

app.get('/stats', (req, res) => res.json({
  uptime:    Math.floor((Date.now() - startTime) / 1000),
  proxyPool: proxy.pool.length,
  projects:  projects.map(p => ({
    slug: p.slug, label: p.label,
    views: p.views, downloads: p.downloads, dlFailed: p.dlFailed,
    cycles: p.cycles, lastView: p.lastView, lastDl: p.lastDl,
  })),
}));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
const startTime = Date.now();

app.listen(PORT, '0.0.0.0', () => {
  log(`Port ${PORT} ready`, 'ok', 'SERVER');
  log(`Running ${projects.length} projects: ${projects.map(p=>p.label).join(', ')}`, 'info', 'SERVER');

  // Stagger project starts by 4s so they don't all hit at once
  projects.forEach((proj, i) => {
    setTimeout(() => runProjectCycle(proj), 1500 + i * 4000);
  });
});
