(function () {
  'use strict';

  var apps = [];
  var pendingDelete = null;
  var lanUrl = '';
  var suppressClick = false;

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

  function host() {
    return (typeof Box !== 'undefined' && Box) ? Box : null;
  }

  // ---------- 列表 ----------

  function load() {
    var raw = '[]';
    var h = host();
    if (h) { try { raw = h.apps(); } catch (e) { raw = '[]'; } }
    try { apps = JSON.parse(raw) || []; } catch (e) { apps = []; }
    render();
  }

  function iconHtml(a) {
    var name = a.name || a.id;
    var letter = esc(String(name).charAt(0));
    if (a.icon) {
      var src = 'https://' + a.id + '.apps.local/' + String(a.icon).replace(/^\//, '');
      return '<div class="ico-wrap">'
        + '<img class="ico" alt="" src="' + esc(src) + '" onerror="this.style.display=\'none\';this.parentNode.querySelector(\'.ico-txt\').style.display=\'flex\'">'
        + '<span class="ico-txt" style="display:none">' + letter + '</span>'
        + '</div>';
    }
    return '<div class="ico-wrap"><span class="ico-txt" style="display:flex">' + letter + '</span></div>';
  }

  function render() {
    var g = $('grid');
    g.innerHTML = '';
    $('empty').style.display = apps.length ? 'none' : 'block';
    for (var i = 0; i < apps.length; i++) {
      (function (a) {
        var card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = iconHtml(a)
          + '<div class="nm">' + esc(a.name || a.id) + '</div>'
          + '<div class="ver">' + (a.version ? 'v' + esc(a.version) : '') + '</div>';
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
    $('add').addEventListener('click', function () {
      openSheet();
      refreshLan();
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
        setTimeout(closeSheet, 600);
      }
    },
    onPickRefresh: function () {
      load();
      toast('收到新包');
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

  bind();
  load();

  var h = host();
  if (h) {
    try {
      var m = JSON.parse(h.meta());
      $('foot').textContent = '小盒子 v' + m.version + ' · OpenMini · 包体独立，装完即玩';
    } catch (e) { /* 忽略 */ }
  }

  window.addEventListener('focus', load, false);
})();
