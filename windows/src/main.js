/* OpenMini 桌面宿主（Windows / Linux 免安装绿色版）
 * 与 Android 版共用一套 host 页面和 zip 包格式：
 *   - om://host.apps.local/        启动器（host/）
 *   - om://<id>.apps.local/*       应用包（apps/<id>/）
 *   不同 hostname = 不同 origin，localStorage 存档天然隔离。
 * 默认不预装任何应用；数据统一放在用户目录 ~/.openmini
 * （程序目录放 portable.txt 可切回「数据跟 exe 走」的便携模式）。
 */
'use strict';

const { app, BrowserWindow, ipcMain, protocol, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const AdmZip = require('adm-zip');
const Paths = require('./paths');

const IS_DEV = !app.isPackaged;
const SRC = __dirname;
const ROOT = path.dirname(SRC);                       // windows/
const DATA_INFO = Paths.resolve({ isDev: IS_DEV, devRoot: ROOT });
const DATA = DATA_INFO.dir;
const APPS = path.join(DATA, 'apps');
const STAGE = path.join(DATA, 'stage');
const HOST_VER = '1.1.0';
const PLATFORM_NAME = process.platform === 'linux' ? '小盒子 Linux 版' : '小盒子 Windows 版';

// Linux 绿色版无法把 chrome-sandbox 设成 setuid root；未配置时降级为 --no-sandbox，
// 否则 Chromium 会直接拒绝启动。若用户已 sudo 配置过 setuid，则保留完整沙箱。
if (process.platform === 'linux') {
  try {
    const sb = path.join(path.dirname(process.execPath), 'chrome-sandbox');
    if (!(fs.statSync(sb).mode & 0o4000)) app.commandLine.appendSwitch('no-sandbox');
  } catch (e) {
    app.commandLine.appendSwitch('no-sandbox');
  }
}

const GH_PROXY = 'https://gh-proxy.org/';
const MARKET_API = GH_PROXY + 'https://api.github.com/repos/joeyjiaojg/openmini-market/releases/latest';
const MARKET_CATALOG_API = GH_PROXY + 'https://raw.githubusercontent.com/joeyjiaojg/openmini-market/main/catalog.json';
const SELF_API = GH_PROXY + 'https://api.github.com/repos/joeyjiaojg/openmini/releases/latest';

let launcher = null;
const appWins = {};     // id -> BrowserWindow
let marketCache = null; // {ts, apps, tag}

function ensureDirs() {
  // 升级自 v1.0.x 时，把程序目录下旧的 data/ 搬到 ~/.openmini（失败不阻塞启动）
  try { Paths.migrate(DATA_INFO); } catch (e) { }
  [DATA, APPS, STAGE].forEach(function (d) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  });
}

// ---------- 工具 ----------
function safeId(id) { return /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(String(id || '')) && id !== 'host'; }

function readManifest(dir) {
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!safeId(m.id)) return null;
    return m;
  } catch (e) { return null; }
}

function installed() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(APPS); } catch (e) { }
  names.forEach(function (id) {
    const m = readManifest(path.join(APPS, id));
    if (m && m.id === id) {
      out.push({
        id: m.id, name: m.name || m.id, version: m.version || '',
        versionCode: m.versionCode == null ? 1 : m.versionCode,
        icon: m.icon || '', entry: m.entry || 'index.html'
      });
    }
  });
  return out;
}

function httpGet(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 5) return reject(new Error('重定向过多'));
    let mod = https;
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    if (u.protocol === 'http:') mod = require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'OpenMini-Desktop/' + HOST_VER, 'Accept': 'application/vnd.github+json' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(new Error('网络超时')); });
  });
}

function download(url, dest, onPct) {
  return new Promise(function (resolve, reject) {
    function go(u, n) {
      if (n > 5) return reject(new Error('重定向过多'));
      let mod = https;
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(e); }
      if (parsed.protocol === 'http:') mod = require('http');
      const req = mod.get(u, { headers: { 'User-Agent': 'OpenMini-Desktop/' + HOST_VER } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return go(new URL(res.headers.location, u).href, n + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0, last = -1;
        const tmp = dest + '.part';
        const out = fs.createWriteStream(tmp);
        res.on('data', function (c) {
          got += c.length; out.write(c);
          if (total && onPct) {
            const pct = Math.min(99, Math.floor(got * 100 / total));
            if (pct !== last) { last = pct; onPct(pct); }
          }
        });
        res.on('end', function () { out.end(function () { fs.renameSync(tmp, dest); resolve(); }); });
        res.on('error', function (e) { out.destroy(); reject(e); });
      });
      req.on('error', reject);
      req.setTimeout(60000, function () { req.destroy(new Error('下载超时')); });
    }
    go(url, 0);
  });
}

function event(ev, data) {
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send('om-event', { type: ev, data: data });
}

// ---------- 市场 ----------
function fetchMarket(force) {
  if (!force && marketCache && Date.now() - marketCache.ts < 5 * 60 * 1000) {
    event('onMarket', { ok: true, apps: marketCache.apps, tag: marketCache.tag });
    return;
  }
  Promise.all([
    httpGet(MARKET_CATALOG_API).then(function (b) { return JSON.parse(b.toString('utf8')); }).catch(function () { return {}; }),
    httpGet(MARKET_API).then(function (b) { return JSON.parse(b.toString('utf8')); })
  ]).then(function (r) {
    const catalog = {};
    (r[0].apps || []).forEach(function (c) { if (c.id) catalog[c.id] = c; });
    const rel = r[1];
    const apps = [];
    (rel.assets || []).forEach(function (a) {
      const name = String(a.name || '');
      if (!/\.zip$/i.test(name)) return;
      const dl = String(a.browser_download_url || '');
      if (!dl.startsWith('https://github.com/')) return;
      const stem = name.replace(/\.zip$/i, '');
      const dash = stem.lastIndexOf('-v');
      const id = (dash > 0 ? stem.slice(0, dash) : stem).toLowerCase();
      if (!safeId(id)) return;
      const item = {
        id: id, name: id, size: a.size || 0,
        version: dash > 0 ? stem.slice(dash + 2) : '',
        url: GH_PROXY + dl
      };
      const meta = catalog[id];
      if (meta) ['name', 'desc', 'category', 'icon', 'version', 'versionCode'].forEach(function (k) {
        if (meta[k] !== undefined) item[k] = meta[k];
      });
      apps.push(item);
    });
    marketCache = { ts: Date.now(), apps: apps, tag: rel.tag_name || '' };
    event('onMarket', { ok: true, apps: apps, tag: marketCache.tag });
  }).catch(function (e) {
    event('onMarket', { ok: false, msg: '市场暂时不可用: ' + (e.message || '网络错误') });
  });
}

// ---------- 安装 ----------
function failInstall(msg) { event('onResult', { ok: false, msg: msg }); }

function installBuffer(buf, source) {
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { return failInstall('不是有效的 zip 包'); }
  let entries;
  try { entries = zip.getEntries(); } catch (e) { return failInstall('zip 读取失败: ' + e.message); }
  // zip-slip 防护
  for (const e of entries) {
    const n = String(e.entryName || '').replace(/\\/g, '/');
    if (n.indexOf('..') >= 0 || /^[a-zA-Z]:/.test(n) || n.charAt(0) === '/') {
      return failInstall('包内含有非法路径，已拒绝');
    }
  }
  let base = '';
  const names = entries.map(function (e) { return String(e.entryName).replace(/\\/g, '/'); });
  // 剥掉一层子目录
  const first = names[0] || '';
  if (names.every(function (n) { return n.indexOf(first.split('/')[0] + '/') === 0; }) &&
    !names.some(function (n) { return n === 'manifest.json'; })) {
    base = first.split('/')[0] + '/';
  }
  const rel = function (n) { return n.indexOf(base) === 0 ? n.slice(base.length) : n; };
  const has = function (f) { return names.some(function (n) { return rel(n) === f; }); };
  if (!has('manifest.json')) return failInstall('包内缺少 manifest.json');
  let man;
  try { man = JSON.parse(zip.readAsText(base + 'manifest.json')); } catch (e) { return failInstall('manifest.json 解析失败'); }
  if (!safeId(man.id)) return failInstall('manifest id 不合法或为保留字');
  const entry = man.entry || 'index.html';
  if (!has(entry)) return failInstall('入口文件不存在: ' + entry);
  let size = 0;
  entries.forEach(function (e) { size += e.header.size || 0; });
  if (size > 40 * 1024 * 1024) return failInstall('解压后超过 40MB 限制');

  const dir = path.join(STAGE, man.id + '-' + Date.now());
  try {
    fs.mkdirSync(dir, { recursive: true });
    entries.forEach(function (e) {
      if (e.isDirectory) return;
      const n = rel(String(e.entryName).replace(/\\/g, '/'));
      if (!n) return;
      const out = path.join(dir, n);
      const pd = path.dirname(out);
      fs.mkdirSync(pd, { recursive: true });
      fs.writeFileSync(out, e.getData());
    });
    // 校验写出的 manifest 与包内一致（防止路径处理出错）
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (written.id !== man.id) throw new Error('manifest 校验失败');
    const target = path.join(APPS, man.id);
    const backup = path.join(STAGE, man.id + '-old-' + Date.now());
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.mkdirSync(APPS, { recursive: true });
    fs.renameSync(dir, target);
    try { if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true }); } catch (e) { }
    event('onResult', { ok: true, msg: '已安装 ' + (man.name || man.id) + ' v' + (man.version || '') });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { }
    failInstall('安装失败: ' + (e.message || e));
  }
}

function installUrl(url) {
  if (!/^https:\/\/gh-proxy\.org\/https:\/\/github\.com\//.test(String(url || ''))) {
    return failInstall('下载地址不合法');
  }
  const tmp = path.join(STAGE, 'dl-' + Date.now() + '.zip');
  event('onProgress', 3);
  download(url, tmp, function (pct) { event('onProgress', 3 + Math.floor(pct * 0.9)); })
    .then(function () {
      event('onProgress', 96);
      installBuffer(fs.readFileSync(tmp), url);
      try { fs.unlinkSync(tmp); } catch (e) { }
    })
    .catch(function (e) { failInstall('下载失败: ' + (e.message || e)); });
}

function pickZip() {
  dialog.showOpenDialog(launcher, {
    title: '选择一个应用包（zip）',
    filters: [{ name: 'OpenMini 应用包', extensions: ['zip'] }],
    properties: ['openFile']
  }).then(function (r) {
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return;
    try {
      const buf = fs.readFileSync(r.filePaths[0]);
      event('onProgress', 50);
      installBuffer(buf, r.filePaths[0]);
    } catch (e) { failInstall('读取文件失败: ' + e.message); }
  });
}

// ---------- 应用窗口 ----------
function openApp(id) {
  const dir = path.join(APPS, id);
  const m = readManifest(dir);
  if (!m) { if (launcher) launcher.webContents.send('om-event', { type: 'onResult', data: { ok: false, msg: '应用不存在或已损坏' } }); return; }
  if (appWins[id] && !appWins[id].isDestroyed()) { appWins[id].focus(); return; }
  const landscape = /landscape/i.test(m.orientation || '');
  const w = new BrowserWindow({
    width: landscape ? 1100 : 460, height: landscape ? 700 : 880,
    minWidth: 320, minHeight: 480,
    title: m.name || id,
    backgroundColor: '#15120e',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: false,
      webSecurity: true, allowRunningInsecureContent: false
    }
  });
  appWins[id] = w;
  const entry = String(m.entry || 'index.html').replace(/^\//, '');
  w.loadURL('om://' + id + '.apps.local/' + entry);
  // Esc / Alt+Left 回到盒子
  w.webContents.on('before-input-event', function (e, input) {
    if (input.type === 'keyDown' && (input.key === 'Escape' || (input.key === 'ArrowLeft' && input.alt))) {
      e.preventDefault(); w.close();
    }
  });
  // 应用内外部链接交给系统浏览器（与 Android handleNavigation 一致）
  w.webContents.on('will-navigate', function (e, url) {
    if (/^https?:/i.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  w.webContents.setWindowOpenHandler(function (d) {
    if (/^https?:/i.test(d.url)) shell.openExternal(d.url);
    return { action: 'deny' };
  });
  w.on('closed', function () { delete appWins[id]; if (launcher && !launcher.isDestroyed()) launcher.focus(); });
}

function closeApp(id) {
  if (appWins[id] && !appWins[id].isDestroyed()) appWins[id].close();
}

// ---------- 同步桥 ----------
function handleCall(payload) {
  const m = payload && payload.m;
  const a = payload && payload.a;
  switch (m) {
    case 'apps': return JSON.stringify(installed());
    case 'meta': return JSON.stringify({
      version: HOST_VER, name: PLATFORM_NAME, lanRunning: false,
      platform: process.platform, dataDir: DATA, dataMode: DATA_INFO.mode
    });
    case 'market': fetchMarket(false); return '';
    case 'updateCheck': return JSON.stringify({ ok: true, hasUpdate: false, version: HOST_VER, local: HOST_VER, size: 0, notes: '' });
    case 'updateInstall': return JSON.stringify({ ok: false, msg: '桌面版请从 GitHub Releases 手动更新' });
    case 'installUrl': installUrl(a); return '';
    case 'pick': pickZip(); return '';
    case 'remove': {
      if (!safeId(a)) return '';
      const dir = path.join(APPS, a);
      closeApp(a);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
      event('onResult', { ok: true, msg: '已删除，存档仍在' });
      return '';
    }
    case 'open': openApp(a); return '';
    case 'home': closeApp(a); return '';
    case 'back': closeApp(a); return '';
    case 'setOverlay': return '';
    case 'toastMsg': return '';
    case 'serverStart': return JSON.stringify({ ok: false, msg: '桌面版请用「本地文件」直接选 zip 安装' });
    case 'serverStop': return JSON.stringify({ ok: true });
    default: return '';
  }
}

// ---------- 启动 ----------
protocol.registerSchemesAsPrivileged([{
  scheme: 'om', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

app.whenReady().then(function () {
  ensureDirs();

  protocol.registerFileProtocol('om', function (request, cb) {
    try {
      const u = new URL(request.url);
      const host = u.hostname.toLowerCase();
      let base;
      let p = decodeURIComponent(u.pathname.split('?')[0]);
      if (p === '/' || p === '') p = '/index.html';
      if (host === 'host.apps.local') base = path.join(SRC, 'host');
      else if (/(^|\.)apps\.local$/.test(host)) {
        const id = host.replace(/\.apps\.local$/, '');
        if (!safeId(id)) return cb({ error: -6 });
        base = path.join(APPS, id);
      } else return cb({ error: -6 });
      const file = path.join(base, p.replace(/^\/+/, ''));
      // 目录穿越防护
      if (file.indexOf(base) !== 0) return cb({ error: -6 });
      cb({ path: file });
    } catch (e) { cb({ error: -6 }); }
  });

  ipcMain.on('om-call', function (e, payload) { e.returnValue = handleCall(payload); });

  launcher = new BrowserWindow({
    width: 480, height: 760, minWidth: 380, minHeight: 560,
    title: '小盒子 · OpenMini',
    backgroundColor: '#15120e',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: false,
      preload: path.join(SRC, 'preload.js')
    }
  });
  launcher.loadURL('om://host.apps.local/index.html');

  launcher.on('closed', function () {
    Object.keys(appWins).forEach(function (id) { if (appWins[id] && !appWins[id].isDestroyed()) appWins[id].close(); });
    launcher = null;
    app.quit();
  });
});

app.on('window-all-closed', function () { app.quit(); });
