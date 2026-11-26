(function () {
  'use strict';

  var apps = [];
  var marketApps = [];
  var marketLoaded = false;
  var marketQuery = '';      // 市场搜索关键词
  var marketCategory = '';   // 市场分类筛选，''=全部
  var selfUpdate = null;      // 宿主自升级检查结果
  var selfChecking = false;
  var selfDownloading = false;
  var pendingDelete = null;
  var lanUrl = '';
  var suppressClick = false;
  var mainView = 'market';   // 主 Tab：market / installed

  // 市场里已装应用的版本，用来显示"已安装/可更新"
  function installedById(id) {
    for (var i = 0; i < apps.length; i++) if (apps[i].id === id) return apps[i];
    return null;
  }

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast on';
    if (t._timer) clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 2000);
  }

  // 宿主桥：Android 走 prompt() 通道，Windows / Linux 桌面版走 Electron preload 暴露的 __om.call。
  // 只有 https://host.apps.local（Android）或 om://host.apps.local（桌面版）这个页面能拿到能力。
  // 装进来的应用即使自己调 prompt，也只会收到 forbidden。
  function inHost() {
    var proto = location.protocol;
    return (proto === 'https:' || proto === 'om:') &&
      /(^|\.)host\.apps\.local$/i.test(location.hostname);
  }

  function call(m, a) {
    var payload = { m: m, a: a === undefined ? null : a };
    // 桌面版（Windows / Linux）：preload 注入 window.__om.call（同步 IPC）
    if (window.__om && typeof window.__om.call === 'function') {
      try {
        var w = window.__om.call(payload);
        return w == null ? '' : w;
      } catch (e) { return ''; }
    }
    // Android：prompt 被 MainActivity.onJsPrompt 拦截
    try {
      var r = prompt('__om__' + JSON.stringify(payload));
      return r == null ? '' : r;
    } catch (e) {
      return '';
    }
  }

  var api = {
    apps: function () { return call('apps'); },
    market: function (force) { call('market', !!force); },
    updateCheck: function () { call('updateCheck'); },
    updateInstall: function () { call('updateInstall'); },
    meta: function () { return call('meta'); },
    installUrl: function (u) { call('installUrl', u); },
    pick: function () { call('pick'); },
    remove: function (id) { call('remove', id); },
    open: function (id) { call('open', id); },
    home: function () { call('home'); },
    back: function () { call('back'); },
    serverStart: function () { return call('serverStart'); },
    serverStop: function () { call('serverStop'); },
    setOverlay: function (v) { call('setOverlay', !!v); },
    toastMsg: function (m) { call('toastMsg', m); }
  };

  function host() {
    return inHost() ? api : null;
  }

  // ---------- 列表 ----------

  function load() {
    var raw = '[]';
    var h = host();
    if (h) { try { raw = h.apps(); } catch (e) { raw = '[]'; } }
    try { apps = JSON.parse(raw) || []; } catch (e) { apps = []; }
    render();
  }

  // 全部用 createElement 建节点：包 manifest 里的 name/icon 都当不可信文本处理，
  // 不进 innerHTML，也就没有属性注入/脚本注入的可能。
  function iconNode(a) {
    var name = String(a.name || a.id || '?');
    var wrap = document.createElement('div');
    wrap.className = 'ico-wrap';

    var letter = document.createElement('span');
    letter.className = 'ico-txt';
    letter.textContent = name.charAt(0).toUpperCase();

    if (a.icon) {
      var img = document.createElement('img');
      img.className = 'ico';
      img.alt = '';
      img.onerror = function () {
        img.style.display = 'none';
        letter.style.display = 'flex';
      };
      img.src = location.protocol + '//' + a.id + '.apps.local/' + String(a.icon).replace(/^\//, '');
      letter.style.display = 'none';
      wrap.appendChild(img);
    } else {
      letter.style.display = 'flex';
    }
    wrap.appendChild(letter);
    return wrap;
  }

  // 应用当前生效的分类：只有 catalog 带 category 时才显示分类栏
  function marketCategories() {
    var seen = {};
    var cats = [];
    for (var i = 0; i < marketApps.length; i++) {
      var c = marketApps[i].category;
      if (c && !seen[c]) { seen[c] = 1; cats.push(c); }
    }
    return cats;
  }

  function appDisplayName(it) {
    return it.name || prettyName(it.id);
  }

  function renderMarketCats() {
    var bar = $('mktCats');
    if (!bar) return;
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    var cats = marketCategories();
    // 只有一个或零个分类时不显示分类栏，避免无意义的一行
    if (cats.length < 2) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    var all = ['',].concat(cats);
    for (var i = 0; i < all.length; i++) {
      (function (cat) {
        var b = document.createElement('button');
        b.className = 'mkt-cat' + (marketCategory === cat ? ' on' : '');
        b.textContent = cat === '' ? '全部' : cat;
        b.addEventListener('click', function () {
          marketCategory = cat;
          renderMarketCats();
          renderMarket();
        }, false);
        bar.appendChild(b);
      })(all[i]);
    }
  }

  function renderMarket() {
    var box = $('marketList');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var tip = $('marketTip');
    var tools = $('mktTools');
    if (tools) tools.style.display = 'none';
    if (!marketLoaded) {
      if (tip) tip.textContent = '正在获取最新应用…';
      return;
    }
    if (!marketApps.length) {
      if (tip) tip.textContent = '市场暂时打不开，不影响本地应用。';
      return;
    }
    if (tip) tip.textContent = '小盒子官方市场 · 点一下就装';
    if (tools) tools.style.display = '';
    renderMarketCats();

    var q = (marketQuery || '').trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < marketApps.length; i++) {
      (function (it) {
        // 分类过滤
        if (marketCategory && it.category !== marketCategory) return;
        // 关键词过滤：名称 / id / 描述 / 分类
        if (q) {
          var hay = [it.name, prettyName(it.id), it.id, it.desc, it.category]
            .join(' ').toLowerCase();
          if (hay.indexOf(q) < 0) return;
        }
        shown++;
        var row = document.createElement('div');
        row.className = 'mkt-item';

        var ico = document.createElement('div');
        ico.className = 'mkt-ico';
        ico.textContent = it.icon || (it.id || '?').charAt(0).toUpperCase();
        row.appendChild(ico);

        var mid = document.createElement('div');
        mid.className = 'mkt-mid';
        var nm = document.createElement('div');
        nm.className = 'mkt-nm';
        nm.textContent = appDisplayName(it);
        mid.appendChild(nm);
        var sub = document.createElement('div');
        sub.className = 'mkt-sub';
        var inst = installedById(it.id);
        var cmp = inst ? cmpVer(inst, it) : -1;
        var isLatest = !!inst && cmp >= 0;
        if (isLatest) {
          sub.textContent = '已装 v' + (inst.version || it.version || '?') + ' · 已是最新';
        } else if (inst) {
          sub.textContent = '已装 v' + (inst.version || '?') + ' · 可更新 v' + (it.version || '?');
        } else {
          sub.textContent = 'v' + (it.version || '?') + ' · ' + fmtSize(it.size);
        }
        mid.appendChild(sub);
        if (it.desc) {
          var ds = document.createElement('div');
          ds.className = 'mkt-desc';
          ds.textContent = it.desc;
          mid.appendChild(ds);
        }
        row.appendChild(mid);

        var btn;
        if (isLatest) {
          // 已是最新版：只展示状态，不给点击更新的入口
          btn = document.createElement('span');
          btn.className = 'mkt-btn latest';
          btn.textContent = '已最新';
        } else {
          btn = document.createElement('button');
          btn.className = 'mkt-btn' + (inst ? ' ghost' : '');
          btn.textContent = inst ? '更新' : '安装';
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            doInstallMarket(it);
          }, false);
        }
        row.appendChild(btn);
        box.appendChild(row);
      })(marketApps[i]);
    }
    if (!shown) {
      var none = document.createElement('div');
      none.className = 'mkt-none';
      none.textContent = '没有匹配的应用';
      box.appendChild(none);
    }
  }

  // 市场版本比较：优先 versionCode（整数），没有则按点分版本号逐段比数字。
  // 返回 -1 表示 a 旧，0 相同，1 表示 a 新。
  function cmpVer(a, b) {
    var ac = a && a.versionCode, bc = b && b.versionCode;
    if (ac !== undefined && ac !== null && ac !== '' &&
        bc !== undefined && bc !== null && bc !== '') {
      var ai = parseInt(ac, 10), bi = parseInt(bc, 10);
      if (isFinite(ai) && isFinite(bi)) {
        return ai < bi ? -1 : (ai > bi ? 1 : 0);
      }
    }
    var av = String((a && a.version) || ''), bv = String((b && b.version) || '');
    if (!av || !bv) return av === bv ? 0 : (av ? 1 : -1);
    var as = av.split(/[.-]/), bs = bv.split(/[.-]/);
    var n = Math.max(as.length, bs.length);
    for (var i = 0; i < n; i++) {
      var x = parseInt(as[i] || '0', 10), y = parseInt(bs[i] || '0', 10);
      if (!isFinite(x)) x = 0;
      if (!isFinite(y)) y = 0;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }

  function prettyName(id) {
    var map = { mahjong: '血战到底', xiangqi: '楚汉象棋', wordbuddy: 'WordBuddy 背单词', demo: '弹珠屏保' };
    return map[id] || id || '应用';
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB';
  }

  function doInstallMarket(it) {
    var h = host();
    if (!h) { toast('浏览器里预览不支持'); return; }
    if (!/^https:\/\/gh-proxy\.org\/https:\/\/github\.com\//.test(it.url)) {
      toast('下载地址不合法'); return;
    }
    openSheet();
    $('prog').className = 'prog on';
    $('progBar').style.width = '0%';
    $('msg').textContent = '正在下载 ' + appDisplayName(it) + '…';
    h.installUrl(it.url);
  }

  function fetchMarket(force) {
    var h = host();
    if (!h) return;
    marketLoaded = false;
    renderMarket();
    var btn = $('mktRefresh');
    if (btn && force) btn.className = 'mkt-refresh spin';
    h.market(!!force);
  }

  function setMainView(name) {
    mainView = name;
    var tabs = document.querySelectorAll('.main-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].className = 'main-tab' + (tabs[i].getAttribute('data-view') === name ? ' on' : '');
    }
    $('view-market').className = 'view' + (name === 'market' ? ' on' : '');
    $('view-installed').className = 'view' + (name === 'installed' ? ' on' : '');
  }

  // ---------- 宿主自升级 ----------

  function renderUpdate() {
    var sub = $('updSub'), btn = $('updBtn'), notes = $('updNotes');
    if (!sub || !btn) return;

    if (selfDownloading) {
      sub.textContent = '正在下载新版本…';
      setBtn(btn, '下载中', 'ghost', true);
      return;
    }
    if (selfChecking) {
      sub.textContent = '正在检查更新…';
      setBtn(btn, '检查中', 'ghost', true);
      return;
    }
    var s = selfUpdate;
    if (!s) {
      sub.textContent = '尚未检查';
      setBtn(btn, '检查', 'ghost', false);
      return;
    }
    if (!s.ok) {
      sub.textContent = s.msg || '检查失败，点重试';
      setBtn(btn, '重试', 'ghost', false);
      notes.textContent = '';
      return;
    }
    var has = !!s.hasUpdate;
    sub.textContent = has
      ? ('发现新版本 v' + s.version + ' · 当前 v' + s.local + ' · ' + fmtSize(s.size))
      : ('已是最新版本 v' + s.local);
    setBtn(btn, has ? '立即更新' : '已最新', has ? 'solid' : 'latest', false);
    notes.textContent = has ? (s.notes || '') : '';
  }

  function setBtn(btn, text, cls, disabled) {
    btn.textContent = text;
    btn.className = 'upd-btn ' + cls;
    btn.disabled = !!disabled;
  }

  function fetchUpdate() {
    var h = host();
    if (!h) { return; } // 浏览器预览不支持
    selfChecking = true;
    renderUpdate();
    h.updateCheck();
  }

  function doSelfUpdate() {
    if (!selfUpdate || !selfUpdate.ok || !selfUpdate.hasUpdate) return;
    var h = host();
    if (!h) return;
    selfDownloading = true;
    $('updProg').className = 'upd-prog on';
    $('updProgBar').style.width = '0%';
    renderUpdate();
    h.updateInstall();
  }

  function render() {
    renderMarket();
    var g = $('grid');
    while (g.firstChild) g.removeChild(g.firstChild);
    $('empty').style.display = apps.length ? 'none' : 'block';
    for (var i = 0; i < apps.length; i++) {
      (function (a) {
        var card = document.createElement('div');
        card.className = 'card';
        card.appendChild(iconNode(a));

        var nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = String(a.name || a.id || '');
        card.appendChild(nm);

        var ver = document.createElement('div');
        ver.className = 'ver';
        ver.textContent = a.version ? 'v' + String(a.version) : '';
        card.appendChild(ver);

        bindCard(card, a);
        g.appendChild(card);
      })(apps[i]);
    }
  }

  function openApp(id) {
    var h = host();
    if (h) h.open(id);
  }

  function bindCard(card, app) {
    var timer = null;
    var longFired = false;

    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function press() {
      longFired = false;
      cancel();
      timer = setTimeout(function () {
        timer = null;
        longFired = true;
        suppressClick = true;
        askDelete(app);
      }, 620);
    }

    function release() { cancel(); }

    card.addEventListener('touchstart', press, false);
    card.addEventListener('touchend', release, false);
    card.addEventListener('touchmove', release, false);
    card.addEventListener('touchcancel', release, false);
    card.addEventListener('mousedown', press, false);
    card.addEventListener('mouseup', release, false);
    card.addEventListener('mouseleave', release, false);

    card.addEventListener('click', function () {
      if (longFired || suppressClick) { longFired = false; suppressClick = false; return; }
      openApp(app.id);
    }, false);
  }

  // ---------- 安装面板 ----------

  function openSheet() {
    $('mask').className = 'mask on';
    $('sheet').className = 'sheet on';
    if (host()) { try { host().setOverlay(true); } catch (e) { } }
  }

  function closeSheet() {
    $('mask').className = 'mask';
    $('sheet').className = 'sheet';
    $('msg').textContent = '';
    $('prog').className = 'prog';
    if (host()) { try { host().setOverlay(false); } catch (e) { } }
  }

  function setTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].className = 'tab' + (tabs[i].getAttribute('data-tab') === name ? ' on' : '');
    }
    $('pane-link').className = 'pane' + (name === 'link' ? ' on' : '');
    $('pane-file').className = 'pane' + (name === 'file' ? ' on' : '');
    $('pane-lan').className = 'pane' + (name === 'lan' ? ' on' : '');
  }

  function refreshLan() {
    var h = host();
    var box = $('lanBox');
    var btn = $('doLan');
    if (!h) { box.textContent = '浏览器里预览不支持'; return; }
    var m = {};
    try { m = JSON.parse(h.meta()); } catch (e) { m = {}; }
    if (m.lanRunning && m.serverSocket) {
      lanUrl = m.serverSocket;
      box.textContent = lanUrl;
      box.className = 'lanbox on';
      btn.textContent = '关闭通道';
      btn.className = 'go ghost';
    } else {
      lanUrl = '';
      box.textContent = '未开启';
      box.className = 'lanbox';
      btn.textContent = '开启上传通道';
      btn.className = 'go';
    }
  }

  // ---------- 交互绑定 ----------

  function bind() {
    var mainTabs = document.querySelectorAll('.main-tab');
    for (var i = 0; i < mainTabs.length; i++) {
      (function (t) {
        t.addEventListener('click', function () { setMainView(t.getAttribute('data-view')); }, false);
      })(mainTabs[i]);
    }

    $('mktRefresh').addEventListener('click', function () {
      var btn = this;
      if (btn.className.indexOf('spin') >= 0) return;
      if (!host()) { toast('浏览器里预览不支持'); return; }
      btn.className = 'mkt-refresh spin';
      fetchMarket(true);
      toast('正在刷新应用市场…');
    }, false);

    $('mktSearch').addEventListener('input', function () {
      marketQuery = this.value;
      renderMarket();
    }, false);

    $('add').addEventListener('click', function () {
      openSheet();
      refreshLan();
    }, false);

    $('updBtn').addEventListener('click', function () {
      var s = selfUpdate;
      if (selfChecking || selfDownloading) return;
      if (s && s.ok && s.hasUpdate) doSelfUpdate();
      else fetchUpdate();
    }, false);

    $('mask').addEventListener('click', closeSheet, false);

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); }, false);
      })(tabs[i]);
    }

    $('doLink').addEventListener('click', function () {
      var v = $('url').value.trim();
      if (!v) { toast('先填个地址'); return; }
      if (!/^https?:\/\//i.test(v)) { toast('地址要以 http:// 或 https:// 开头'); return; }
      var h = host();
      if (!h) { toast('浏览器里预览不支持'); return; }
      $('prog').className = 'prog on';
      $('progBar').style.width = '0%';
      $('msg').textContent = '正在连接…';
      h.installUrl(v);
    }, false);

    $('doPick').addEventListener('click', function () {
      var h = host();
      if (!h) { toast('浏览器里预览不支持'); return; }
      h.pick();
    }, false);

    $('doLan').addEventListener('click', function () {
      var h = host();
      if (!h) { toast('浏览器里预览不支持'); return; }
      if (lanUrl) {
        h.serverStop();
        setTimeout(refreshLan, 120);
        toast('通道已关闭');
        return;
      }
      var r = {};
      try { r = JSON.parse(h.serverStart()); } catch (e) { r = {}; }
      if (r.ok) {
        setTimeout(refreshLan, 100);
        toast('通道已开启');
      } else {
        toast(r.msg || '开启失败');
      }
    }, false);

    $('dlgNo').addEventListener('click', function () {
      pendingDelete = null;
      $('dlg').className = 'dlg';
      if (host()) { try { host().setOverlay(false); } catch (e) { } }
    }, false);

    $('dlgYes').addEventListener('click', function () {
      var id = pendingDelete && pendingDelete.id;
      pendingDelete = null;
      $('dlg').className = 'dlg';
      if (host()) { try { host().setOverlay(false); } catch (e) { } }
      if (id && host()) host().remove(id);
    }, false);
  }

  function askDelete(app) {
    pendingDelete = app;
    $('dlgText').textContent = '删除「' + (app.name || app.id) + '」？\n再装回来存档还在。';
    $('dlg').className = 'dlg on';
    if (host()) { try { host().setOverlay(true); } catch (e) { } }
  }

  // ---------- 供 Java 回调 ----------

  window.BoxUI = {
    onMarket: function (r) {
      marketLoaded = true;
      var btn = $('mktRefresh');
      if (btn) btn.className = 'mkt-refresh';
      if (r && r.ok && r.apps) {
        marketApps = r.apps;
      } else {
        marketApps = [];
      }
      renderMarket();
    },
    onProgress: function (pct) {
      $('prog').className = 'prog on';
      $('progBar').style.width = pct + '%';
      $('msg').textContent = '下载中 ' + pct + '%';
    },
    onResult: function (r) {
      $('prog').className = 'prog';
      $('progBar').style.width = '0%';
      var ok = r && r.ok;
      var msg = (r && r.msg) || (ok ? '完成' : '失败');
      $('msg').textContent = msg;
      toast(msg);
      if (ok) {
        $('url').value = '';
        load();
        fetchMarket();
        setTimeout(closeSheet, 600);
      }
    },
    onPickRefresh: function () {
      load();
      fetchMarket();
      toast('收到新包');
    },
    onSelfUpdate: function (r) {
      selfChecking = false;
      selfUpdate = r;
      renderUpdate();
      if (r && r.ok && r.hasUpdate) toast('发现小盒子新版本 v' + r.version);
    },
    onSelfUpdateProgress: function (pct) {
      $('updProg').className = 'upd-prog on';
      $('updProgBar').style.width = pct + '%';
      $('updSub').textContent = '正在下载新版本… ' + pct + '%';
    },
    onSelfInstall: function (r) {
      selfDownloading = false;
      $('updProg').className = 'upd-prog';
      $('updProgBar').style.width = '0%';
      var msg = (r && r.msg) || (r && r.ok ? '完成' : '失败');
      toast(msg);
      if (!r || !r.ok) {
        renderUpdate();
      } else {
        $('updSub').textContent = '正在安装，稍后自动重启…';
        setBtn($('updBtn'), '安装中', 'ghost', true);
      }
    }
  };

  // 返回键交给宿主：应用内按返回回盒子
  window.__onHostBack = function () {
    if (host()) host().home();
  };

  window.BoxUI.closeOverlays = function () {
    if ($('dlg').className.indexOf('on') >= 0) {
      pendingDelete = null;
      $('dlg').className = 'dlg';
    }
    if ($('sheet').className.indexOf('on') >= 0) closeSheet();
  };

  // 桌面版：把主进程推来的异步事件转成 BoxUI 回调（Android 由 Java 直接 js() 调用）
  if (window.__om && typeof window.__om.onEvent === 'function') {
    window.__om.onEvent(function (ev) {
      if (!ev || !ev.type) return;
      var fn = window.BoxUI && window.BoxUI[ev.type];
      if (typeof fn === 'function') fn(ev.data);
    });
  }

  bind();
  load();
  fetchMarket();
  renderUpdate();
  // 进入启动器就自动检查一次更新；有新版再提示，不打扰（无新版不弹窗）
  if (host()) setTimeout(fetchUpdate, 600);

  var h = host();
  if (h) {
    try {
      var m = JSON.parse(h.meta());
      $('foot').textContent = '小盒子 v' + m.version + ' · OpenMini · 包体独立，装完即玩';
    } catch (e) { /* 忽略 */ }
  }

  window.addEventListener('focus', load, false);
})();
