/* 四川血战到底 · 界面渲染（牌面用内联 SVG，无图片依赖） */
(function (global) {
  'use strict';

  var R = global.MJRule;
  var SEL = {
    top: null, left: null, right: null, self: null,
    rivers: {}, center: null, actions: null
  };
  var discardMode = false;
  var pendingCb = null;

  function $(id) { return document.getElementById(id); }
  function asc(a, b) { return a - b; }

  /* XSS 防御：任何进入 innerHTML 的文本一律转义。
   * 当前插值都是内部常量，这里是纵深防御——将来接入外部数据也不会引入注入点 */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- 牌面 SVG ----------------
   * 排列按通行麻将牌面，不再一律用规整网格：
   *  七筒 = 上三斜排(绿) + 下四方的 2×2(红)
   *  七条 = 上1 + 中3 + 下3
   *  八条 = 上倒M(中间∧) + 下M(中间∨)，中间留菱形
   *  红色标记条：五条中心、七条最顶、九条中间整列
   */
  var TONG = {
    1: [[30, 42, 13, 2]],
    2: [[30, 28, 9, 0], [30, 56, 9, 0]],
    3: [[18, 26, 8, 0], [30, 42, 8, 1], [42, 58, 8, 0]],
    4: [[20, 28, 8, 0], [40, 28, 8, 1], [20, 56, 8, 1], [40, 56, 8, 0]],
    5: [[20, 26, 7, 0], [40, 26, 7, 1], [30, 42, 7, 2], [20, 58, 7, 1], [40, 58, 7, 0]],
    6: [[20, 24, 7, 0], [40, 24, 7, 1], [20, 42, 7, 2], [40, 42, 7, 2], [20, 60, 7, 1], [40, 60, 7, 0]],
    7: [[40, 15, 6, 2], [30, 22, 6, 2], [20, 29, 6, 2],
        [22, 49, 6, 1], [38, 49, 6, 1], [22, 66, 6, 1], [38, 66, 6, 1]],
    8: [[20, 20, 6, 0], [40, 20, 6, 1], [20, 36, 6, 1], [40, 36, 6, 0], [20, 52, 6, 0], [40, 52, 6, 1], [20, 68, 6, 1], [40, 68, 6, 0]],
    9: [[18, 22, 6, 0], [30, 22, 6, 1], [42, 22, 6, 2], [18, 42, 6, 1], [30, 42, 6, 2], [42, 42, 6, 0], [18, 62, 6, 2], [30, 62, 6, 0], [42, 62, 6, 1]]
  };
  var TIAO = {
    2: [[30, 16], [30, 48]],
    3: [[30, 10], [18, 44], [42, 44]],
    4: [[20, 18], [40, 18], [20, 50], [40, 50]],
    5: [[20, 14], [40, 14], [30, 34], [20, 54], [40, 54]],
    6: [[20, 10], [40, 10], [20, 32], [40, 32], [20, 54], [40, 54]],
    7: [[30, 9], [16, 36], [30, 36], [44, 36], [16, 62], [30, 62], [44, 62]],
    8: [], // 八条造型特殊，交给 eightSticksSVG()
    9: [[16, 8], [30, 8], [44, 8], [16, 32], [30, 32], [44, 32], [16, 56], [30, 56], [44, 56]]
  };
  var TIAO_RED = { 5: [2], 7: [0], 9: [1, 4, 7] };
  /* 铜钱式筒子三色盘：深描边 + 主色 + 中心点 + 高光，模拟截图里实心彩绘的饼子 */
  var TONG_PALETTE = [
    { dark: '#124a80', main: '#2e7fc1', core: '#eaf3fb' }, // 蓝
    { dark: '#96271f', main: '#d5483c', core: '#fcece8' }, // 红
    { dark: '#11613f', main: '#25a06a', core: '#e9f7ef' }  // 绿
  ];

  function coin(cx, cy, r, ci) {
    var p = TONG_PALETTE[ci % 3];
    var s = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + p.main + '" stroke="' + p.dark + '" stroke-width="1.7"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.52) + '" fill="' + p.dark + '"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.26) + '" fill="' + p.core + '"/>';
    s += '<circle cx="' + (cx - r * 0.32) + '" cy="' + (cy - r * 0.32) + '" r="' + (r * 0.2) + '" fill="#fff" opacity=".42"/>';
    return s;
  }

  /* 竹节式条子：实心绿/红竹段 + 中间的节 + 侧面高光 */
  function bambooStick(cx, cy, isRed) {
    var g = isRed ? '#c0392b' : '#1e9a63';
    var gd = isRed ? '#8c241c' : '#11653f';
    var knot = isRed ? '#f2d24b' : '#c0392b';
    var s = '<rect x="' + (cx - 4) + '" y="' + (cy - 9) + '" width="8" height="18" rx="3.2" fill="' + g + '" stroke="' + gd + '" stroke-width="1"/>';
    s += '<rect x="' + (cx - 4) + '" y="' + (cy - 2.5) + '" width="8" height="5" fill="' + knot + '"/>';
    s += '<rect x="' + (cx - 2.4) + '" y="' + (cy - 7.4) + '" width="4.8" height="1.2" rx=".6" fill="#fff" opacity=".38"/>';
    return s;
  }

  function dotsSVG(rank) {
    var list = TONG[rank] || [];
    var s = '';
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      s += coin(d[0], d[1], d[2], d[3]);
    }
    return s;
  }

  function sticksSVG(rank) {
    if (rank === 1) {
      // 一条：幺鸡（实心竹身 + 鸟头 + 尾羽）
      return '<g>'
        + '<rect x="25.5" y="22" width="9" height="40" rx="4" fill="#1e9a63" stroke="#11653f" stroke-width="1"/>'
        + '<rect x="25.5" y="40" width="9" height="5" fill="#c0392b"/>'
        + '<rect x="27.5" y="26" width="2.4" height="30" rx="1.2" fill="#fff" opacity=".35"/>'
        + '<circle cx="30" cy="17" r="9" fill="#1e9a63" stroke="#11653f" stroke-width="1"/>'
        + '<circle cx="33" cy="15" r="2" fill="#fff"/><circle cx="33.4" cy="15" r="1" fill="#222"/>'
        + '<path d="M25 11 L18 6 L26 9 Z" fill="#c0392b"/>'
        + '<path d="M30 62 L20 74 L30 69 L40 74 Z" fill="#c0392b" stroke="#8c241c" stroke-width="1"/>'
        + '</g>';
    }
    if (rank === 8) return eightSticksSVG();
    var list = TIAO[rank] || [];
    var red = TIAO_RED[rank] || [];
    var s = '';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      s += bambooStick(p[0], p[1] + 8.5, red.indexOf(i) >= 0);
    }
    return s;
  }

  /* 八条：顶部四条倒M(中间∧)、底部四条M(中间∨)，中央交错成菱形，全用竹节 */
  function eightSticksSVG() {
    function stick(cx, cy, deg) {
      var t = deg ? ' transform="rotate(' + deg + ' ' + cx + ' ' + cy + ')"' : '';
      return '<g' + t + '>' + bambooStick(cx, cy, false) + '</g>';
    }
    var s = '';
    s += stick(13, 20, 0) + stick(23, 21, -38) + stick(37, 21, 38) + stick(47, 20, 0);
    s += stick(13, 64, 0) + stick(23, 63, 38) + stick(37, 63, -38) + stick(47, 64, 0);
    return s;
  }

  function wanSVG(rank) {
    var num = R.NUM_CH[rank];
    var font = '"STKaiti","KaiTi","SimSun","Songti SC",serif';
    return '<text x="30" y="41" text-anchor="middle" font-size="38" font-family="' + font + '" font-weight="700" fill="#173a6b">' + num + '</text>'
      + '<text x="30" y="77" text-anchor="middle" font-size="34" font-family="' + font + '" font-weight="700" fill="#c0392b">萬</text>';
  }

  function faceSVG(t) {
    var rank = R.rankOf(t), suit = R.suitOf(t);
    var inner;
    if (suit === 0) inner = wanSVG(rank);
    else if (suit === 1) inner = dotsSVG(rank);
    else inner = sticksSVG(rank);
    return '<svg viewBox="0 0 60 84" preserveAspectRatio="xMidYMid meet">' + inner + '</svg>';
  }

  function tileHTML(t, extra) {
    return '<div class="tile' + (extra ? ' ' + extra : '') + '" data-tile="' + t + '">'
      + '<div class="face">' + faceSVG(t) + '</div></div>';
  }

  function backHTML(extra) {
    return '<div class="tile back' + (extra ? ' ' + extra : '') + '"><div class="patch"></div></div>';
  }

  function meldHTML(meld) {
    var n = meld.type === 'peng' ? 3 : 4;
    var s = '<div class="meld">';
    for (var i = 0; i < n; i++) s += tileHTML(meld.tile, 'sm');
    s += '</div>';
    return s;
  }

  /* ---------------- 座位 ---------------- */
  function renderSeat(G, seat, elId) {
    var p = G.players[seat];
    var el = $(elId);
    if (!el) return;
    var h = '';
    h += '<div class="pinfo' + (p.won ? ' won' : '') + '">';
    h += '<span class="pname">' + esc(p.name) + '</span>';
    h += '<span class="pscore ' + (p.score > 0 ? 'up' : (p.score < 0 ? 'down' : '')) + '">' + (p.score > 0 ? '+' : '') + p.score + '</span>';
    if (p.lack >= 0) h += '<span class="plack">缺' + R.SUIT_CH[p.lack] + '</span>';
    if (p.won) h += '<span class="pwin">' + esc(p.winInfo ? p.winInfo.names.join('+') : '胡') + '</span>';
    h += '</div>';
    h += '<div class="hand-side">';
    if (p.won) {
      var hs = p.hand.slice(0).sort(asc);
      for (var i = 0; i < hs.length; i++) h += tileHTML(hs[i], 'xs');
    } else {
      for (var k = 0; k < p.hand.length; k++) h += backHTML('xs');
    }
    h += '</div>';
    if (p.melds.length) {
      h += '<div class="melds">';
      for (var m = 0; m < p.melds.length; m++) h += meldHTML(p.melds[m]);
      h += '</div>';
    }
    el.innerHTML = h;
  }

  function renderSelf(G) {
    var p = G.players[0];
    var el = $('seat-self');
    var h = '';
    h += '<div class="pinfo">';
    h += '<span class="pname">你</span>';
    h += '<span class="pscore ' + (p.score > 0 ? 'up' : (p.score < 0 ? 'down' : '')) + '">' + (p.score > 0 ? '+' : '') + p.score + '</span>';
    if (p.lack >= 0) h += '<span class="plack">缺' + R.SUIT_CH[p.lack] + '</span>';
    if (p.won) h += '<span class="pwin">' + esc(p.winInfo ? p.winInfo.names.join('+') + ' ' + p.winInfo.score + '分' : '胡') + '</span>';
    h += '<span class="ting" id="tingTip"></span>';
    h += '</div>';

    h += '<div class="self-row">';
    if (p.melds.length) {
      h += '<div class="melds">';
      for (var m = 0; m < p.melds.length; m++) h += meldHTML(p.melds[m]);
      h += '</div>';
    }

    var hand = p.hand.slice(0);
    var last = p.lastDraw;
    if (last >= 0) {
      var idx = hand.lastIndexOf(last);
      if (idx >= 0) hand.splice(idx, 1);
      hand.sort(asc);
      hand.push(last);
    } else {
      hand.sort(asc);
    }
    var cnt = R.cntOf(p.hand);
    h += '<div class="hand" id="hand">';
    for (var i = 0; i < hand.length; i++) {
      var cls = '';
      if (last >= 0 && i === hand.length - 1) cls = 'fresh';
      if (p.lack >= 0 && R.suitOf(hand[i]) === p.lack) cls += ' lack';
      h += tileHTML(hand[i], cls);
    }
    h += '</div>';
    h += '</div>'; // self-row
    el.innerHTML = h;

    // 听牌提示
    if (!p.won && p.lack >= 0) {
      var tip = $('tingTip');
      var w = R.waitingTiles(cnt, p.melds.length);
      var noLack = !hasLack(cnt, p.lack);
      if (tip) {
        if (w.length && noLack) {
          var names = [];
          for (var x = 0; x < w.length; x++) names.push(R.shortName(w[x]));
          tip.textContent = '听 ' + names.join(' ');
          tip.className = 'ting on';
        } else {
          tip.textContent = '';
          tip.className = 'ting';
        }
      }
    }
    el.className = 'seat seat-self' + (discardMode && G.turn === 0 ? ' myturn' : '');
  }

  function hasLack(cnt, suit) {
    for (var i = suit * 9; i < suit * 9 + 9; i++) if (cnt[i] > 0) return true;
    return false;
  }

  function renderRivers(G) {
    var map = { 0: 'river-0', 1: 'river-1', 2: 'river-2', 3: 'river-3' };
    for (var s = 0; s < 4; s++) {
      var el = $(map[s]);
      if (!el) continue;
      var p = G.players[s];
      var h = '<div class="rlabel">' + esc(s === 0 ? '你' : p.name.split(' · ')[0]) + '</div><div class="rcards">';
      for (var i = 0; i < p.discards.length; i++) {
        var isLast = (G.lastDiscard === p.discards[i] && G.fromSeat === s && i === p.discards.length - 1);
        h += tileHTML(p.discards[i], 'xs' + (isLast ? ' hot' : ''));
      }
      h += '</div>';
      el.innerHTML = h;
    }
  }

  function renderCenter(G) {
    var el = $('centerInfo');
    if (!el) return;
    var left = G.wall.length;
    // 血战到底一共摸 wall.length + 已摸的张数，这里直接给剩余未摸数
    var h = '<span class="clabel">剩余</span><b>' + left + '</b><span class="clabel">张</span>';
    el.innerHTML = h;
    el.className = left <= 16 ? 'low' : '';
  }

  function render(G) {
    if (!G) return;
    // 标准麻将：下家在右手边、上家在左手边（摸牌/出牌逆时针轮转）
    renderSeat(G, 2, 'seat-top');
    renderSeat(G, 1, 'seat-right');
    renderSeat(G, 3, 'seat-left');
    renderSelf(G);
    renderRivers(G);
    renderCenter(G);
  }

  /* ---------------- 面板 ---------------- */
  function showLack(cb) {
    var G = global.MJGame.state;
    var counts = [0, 0, 0];
    var hand = G.players[0].hand;
    for (var i = 0; i < hand.length; i++) counts[R.suitOf(hand[i])]++;
    var h = '<div class="panel">'
      + '<h2>定缺</h2>'
      + '<p class="hint">选一门当作缺门。必须先打完这门牌才能胡牌，缺门的牌也不能碰杠。</p>'
      + '<div class="lack-row">';
    for (var s = 0; s < 3; s++) {
      var cls = counts[s] === 0 ? ' zero' : (counts[s] <= 3 ? ' few' : '');
      h += '<button class="lack-btn' + cls + '" data-suit="' + s + '">'
        + '<b>' + R.SUIT_CH[s] + '</b><i>' + counts[s] + ' 张</i></button>';
    }
    h += '</div>'
      + '<p class="hint small">建议缺张数最少的一门</p>'
      + '</div>';
    var ov = $('lackOverlay');
    ov.innerHTML = h;
    ov.className = 'overlay on';
    var btns = ov.querySelectorAll('.lack-btn');
    for (var k = 0; k < btns.length; k++) {
      btns[k].addEventListener('click', function () {
        var suit = parseInt(this.getAttribute('data-suit'), 10);
        hideLack();
        if (global.MJVoice) global.MJVoice.unlock();
        cb(suit);
      }, false);
    }
  }

  function hideLack() {
    var ov = $('lackOverlay');
    if (ov) { ov.className = 'overlay'; ov.innerHTML = ''; }
  }

  function showSelfActions(canWin, canGang, cb) {
    var h = '';
    if (canWin) h += '<button class="act hu" data-act="hu">胡</button>';
    if (canGang) h += '<button class="act gang" data-act="gang">杠</button>';
    if (canWin || canGang) h += '<button class="act pass" data-act="pass">过</button>';
    showActions(h, cb);
  }

  function showClaimActions(human, cb) {
    var h = '';
    if (human.canHu) h += '<button class="act hu" data-act="hu">胡</button>';
    if (human.canGang) h += '<button class="act gang" data-act="gang">杠</button>';
    if (human.canPeng) h += '<button class="act peng" data-act="peng">碰</button>';
    h += '<button class="act pass" data-act="pass">过</button>';
    showActions(h, cb);
  }

  function showActions(html, cb) {
    var el = $('actions');
    el.innerHTML = html;
    el.className = 'actions on';
    pendingCb = cb;
    var btns = el.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var act = this.getAttribute('data-act');
        var f = pendingCb;
        pendingCb = null;
        hideActions();
        if (f) f(act);
      }, false);
    }
  }

  function hideActions() {
    var el = $('actions');
    if (!el) return;
    el.className = 'actions';
    el.innerHTML = '';
    pendingCb = null;
  }

  function chooseGang(gangs, cb) {
    var h = '<div class="panel">'
      + '<h2>选一个杠</h2><div class="gang-row">';
    for (var i = 0; i < gangs.length; i++) {
      h += '<button class="gang-pick" data-i="' + i + '">' + R.tileName(gangs[i].tile)
        + '<i>' + (gangs[i].type === 'angang' ? '暗杠' : '补杠') + '</i></button>';
    }
    h += '</div></div>';
    var ov = $('lackOverlay');
    ov.innerHTML = h;
    ov.className = 'overlay on';
    var btns = ov.querySelectorAll('.gang-pick');
    for (var k = 0; k < btns.length; k++) {
      btns[k].addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-i'), 10);
        hideLack();
        cb(gangs[idx]);
      }, false);
    }
  }

  function setDiscardMode(on) {
    discardMode = !!on;
    var el = $('seat-self');
    if (el) {
      if (on) el.className = 'seat seat-self myturn';
      else el.className = 'seat seat-self';
    }
  }

  function flashWin(p, res) {
    var ov = $('lackOverlay');
    ov.innerHTML = '<div class="winflash"><b>' + (p.isHuman ? '你胡了！' : esc(p.name) + ' 胡了')
      + '</b><i>' + esc(res.names.join(' + ')) + ' · ' + res.score + ' 分</i></div>';
    ov.className = 'overlay on win';
    setTimeout(function () {
      if (ov.className.indexOf('win') >= 0) { ov.className = 'overlay'; ov.innerHTML = ''; }
    }, 1500);
  }

  function showResult(G) {
    var rows = [];
    var order = [0, 1, 2, 3];
    var lvName = ['入门', '进阶', '高手'][G.level] || '进阶';
    var h = '<div class="panel result"><h2>本局结算 <i class="lvtag">' + lvName + '</i></h2><div class="rtable">';
    for (var i = 0; i < order.length; i++) {
      var p = G.players[order[i]];
      var st = '';
      if (p.won) st = p.winInfo ? p.winInfo.names.join('+') : '胡';
      else if (p.huazhu) st = '花猪';
      else if (p.ting) st = '听牌';
      else st = '未听牌';
      h += '<div class="rrow' + (p.won ? ' w' : '') + '">'
        + '<span class="rn">' + esc(p.name) + '</span>'
        + '<span class="rs">' + esc(st) + '</span>'
        + '<span class="rp ' + (p.score > 0 ? 'up' : (p.score < 0 ? 'down' : '')) + '">' + (p.score > 0 ? '+' : '') + p.score + '</span>'
        + '</div>';
    }
    h += '</div><div class="rbtns">'
      + '<button id="btnAgain">再来一局</button>'
      + '<button id="btnHome" class="ghost">回主页</button>'
      + '</div></div>';
    var ov = $('resultOverlay');
    ov.innerHTML = h;
    ov.className = 'overlay on';
    $('btnAgain').addEventListener('click', function () {
      hideResult();
      global.MJGame.restart(global.MJGame.state.auto);
    }, false);
    $('btnHome').addEventListener('click', function () {
      global.MJGame.quit();
    }, false);
  }

  function hideResult() {
    var ov = $('resultOverlay');
    if (ov) { ov.className = 'overlay'; ov.innerHTML = ''; }
  }

  function updateLog(G) {
    var el = $('logBox');
    if (!el) return;
    var lines = G.events.slice(-4);
    var h = '';
    for (var i = 0; i < lines.length; i++) h += '<div>' + esc(lines[i]) + '</div>';
    el.innerHTML = h;
  }

  function bindHand() {
    // 手牌会被反复重建，事件挂在 document 上做委托
    document.addEventListener('click', function (e) {
      var node = e.target;
      var inHand = false;
      while (node && node !== document.body) {
        if (node.id === 'hand') { inHand = true; break; }
        node = node.parentNode;
      }
      if (!inHand) return;
      node = e.target;
      while (node && node.id !== 'hand') {
        if (node.getAttribute && node.getAttribute('data-tile') !== null) {
          var t = parseInt(node.getAttribute('data-tile'), 10);
          if (!isNaN(t)) global.MJGame.humanDiscard(t);
          return;
        }
        node = node.parentNode;
      }
    }, false);
  }

  global.MJUI = {
    render: render,
    showLack: showLack,
    hideLack: hideLack,
    showSelfActions: showSelfActions,
    showClaimActions: showClaimActions,
    showActions: showActions,
    hideActions: hideActions,
    chooseGang: chooseGang,
    setDiscardMode: setDiscardMode,
    flashWin: flashWin,
    showResult: showResult,
    hideResult: hideResult,
    updateLog: updateLog,
    bindHand: bindHand
  };
})(window);
