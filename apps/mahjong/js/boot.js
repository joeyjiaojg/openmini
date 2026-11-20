(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /* ---------- 难度选择（记忆到 localStorage） ---------- */
  var LV_KEY = 'mj_level';
  var lvRow = $('levelRow');
  var curLv = 1;
  try {
    var saved = parseInt(localStorage.getItem(LV_KEY), 10);
    if (saved === 0 || saved === 2) curLv = saved;
  } catch (e) { /* 隐私模式下读不了就默认进阶 */ }
  syncLevelRow();

  function syncLevelRow() {
    var btns = lvRow.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = (parseInt(btns[i].getAttribute('data-lv'), 10) === curLv) ? 'on' : '';
    }
  }

  function applyLevel(lv) {
    if (lv !== 0 && lv !== 1 && lv !== 2) return;
    curLv = lv;
    try { localStorage.setItem(LV_KEY, String(curLv)); } catch (e2) {}
    syncLevelRow();
    if (window.MJGame) window.MJGame.setLevel(lv);
    syncHudLevel();
  }

  lvRow.addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== lvRow) {
      if (node.getAttribute && node.getAttribute('data-lv') !== null) break;
      node = node.parentNode;
    }
    if (!node || node === lvRow) return;
    applyLevel(parseInt(node.getAttribute('data-lv'), 10));
  }, false);

  function curLevel() { return curLv; }

  /* ---------- 对局中 HUD：难度浮层 + 退出 ---------- */
  function syncHudLevel() {
    var row = $('hudLevel');
    if (!row) return;
    var btns = row.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = (parseInt(btns[i].getAttribute('data-lv'), 10) === curLv) ? 'on' : '';
    }
  }

  var hudLevelBox = $('hudLevel');
  var hudLevelBtn = $('btnHudLevel');
  if (hudLevelBtn) {
    hudLevelBtn.addEventListener('click', function () {
      syncHudLevel();
      hudLevelBox.className = hudLevelBox.className.indexOf('on') >= 0 ? 'hud-level' : 'hud-level on';
    }, false);
  }
  if (hudLevelBox) {
    hudLevelBox.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== hudLevelBox) {
        if (node.getAttribute && node.getAttribute('data-lv') !== null) break;
        node = node.parentNode;
      }
      if (!node || node === hudLevelBox) return;
      applyLevel(parseInt(node.getAttribute('data-lv'), 10));
      hudLevelBox.className = 'hud-level';
    }, false);
  }
  var hudQuit = $('btnHudQuit');
  if (hudQuit) {
    hudQuit.addEventListener('click', function () {
      if (window.MJGame) window.MJGame.quit();
    }, false);
  }
  syncHudLevel();

  $('btnPlay').addEventListener('click', function () {
    global_unlock();
    $('homeOverlay').className = 'overlay';
    window.MJGame.start(false, curLevel());
  }, false);

  $('btnWatch').addEventListener('click', function () {
    global_unlock();
    $('homeOverlay').className = 'overlay';
    window.MJGame.start(true, curLevel());
  }, false);

  var soundBtn = $('btnSound');
  soundBtn.addEventListener('click', function () {
    var on = window.MJVoice.toggle();
    soundBtn.textContent = '语音：' + (on ? '开' : '关');
    if (on) window.MJVoice.tile(4);
  }, false);

  function global_unlock() {
    if (window.MJVoice) window.MJVoice.unlock();
  }

  window.MJUI.bindHand();
})();
