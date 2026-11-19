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

  lvRow.addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== lvRow) {
      if (node.getAttribute && node.getAttribute('data-lv') !== null) break;
      node = node.parentNode;
    }
    if (!node || node === lvRow) return;
    curLv = parseInt(node.getAttribute('data-lv'), 10);
    try { localStorage.setItem(LV_KEY, String(curLv)); } catch (e2) {}
    syncLevelRow();
  }, false);

  function curLevel() { return curLv; }

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
