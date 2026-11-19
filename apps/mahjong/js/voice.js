/* 打牌语音：本地 mp3，队列播放避免重叠 */
(function (global) {
  'use strict';

  var enabled = true;
  var unlocked = false;
  var pool = {};
  var queue = [];
  var playing = false;

  var ACTS = ['peng', 'gang', 'angang', 'bugang', 'hu', 'zimo', 'dingque', 'liuju', 'ting'];

  function file(name) { return 'voice/' + name + '.mp3'; }

  function get(name) {
    if (!pool[name]) {
      try {
        var a = new Audio(file(name));
        a.preload = 'auto';
        pool[name] = a;
      } catch (e) { return null; }
    }
    return pool[name];
  }

  function pump() {
    if (playing || !queue.length) return;
    var name = queue.shift();
    var a = get(name);
    if (!a) { pump(); return; }
    playing = true;
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      playing = false;
      pump();
    }
    a.onended = finish;
    a.onerror = finish;
    try {
      a.currentTime = 0;
      var pr = a.play();
      if (pr && pr['catch']) pr['catch'](finish);
    } catch (e) { finish(); return; }
    setTimeout(finish, 2600);
  }

  function play(name) {
    if (!enabled || !unlocked) return;
    if (queue.length > 3) queue.length = 0;
    queue.push(name);
    pump();
  }

  function preload() {
    var i;
    for (i = 0; i < 27; i++) get('p' + i);
    for (i = 0; i < ACTS.length; i++) get('a_' + ACTS[i]);
  }

  global.MJVoice = {
    unlock: function () {
      if (unlocked) return;
      unlocked = true;
      try { preload(); } catch (e) {}
    },
    tile: function (t) { play('p' + t); },
    act: function (name) { play('a_' + name); },
    toggle: function () {
      enabled = !enabled;
      if (!enabled) {
        queue.length = 0;
        for (var k in pool) if (pool.hasOwnProperty(k)) { try { pool[k].pause(); } catch (e) {} }
      }
      return enabled;
    },
    isOn: function () { return enabled; }
  };
})(window);
