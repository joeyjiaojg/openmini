/* 四川血战到底 · 对局流程
 * 发牌 → 定缺 → 摸打 → 副露响应 → 血战继续 → 流局查叫
 */
(function (global) {
  'use strict';

  var R = global.MJRule, AI = global.MJAI, UI = global.MJUI, V = global.MJVoice;
  var G = null;
  var timers = [];
  var LEVEL_NAME = ['入门', '进阶', '高手'];
  var curLevel = 1;

  function later(fn, ms) {
    var id = setTimeout(function () {
      for (var i = 0; i < timers.length; i++) if (timers[i] === id) { timers.splice(i, 1); break; }
      if (G && G.over) return;
      fn();
    }, ms);
    timers.push(id);
    return id;
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
    if (G && G.humanTimer) { clearTimeout(G.humanTimer); G.humanTimer = null; }
  }

  function sortHand(h) {
    h.sort(function (a, b) { return a - b; });
  }
  function removeOne(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) { arr.splice(i, 1); return true; }
    return false;
  }
  function countIn(arr, v) {
    var n = 0;
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) n++;
    return n;
  }

  function seenCount() {
    var c = R.emptyCnt();
    var i, j;
    for (i = 0; i < 4; i++) {
      var d = G.players[i].discards;
      for (j = 0; j < d.length; j++) c[d[j]]++;
    }
    for (i = 0; i < 4; i++) {
      var m = G.players[i].melds;
      for (j = 0; j < m.length; j++) {
        c[m[j].tile] += (m[j].type === 'peng' ? 3 : 4);
      }
    }
    return c;
  }

  /* ================= 开局 ================= */
  function startGame(auto, level) {
    if (typeof level === 'number') curLevel = level;
    AI.setLevel(curLevel);
    clearTimers();
    G = {
      auto: !!auto,
      level: curLevel,
      players: [],
      wall: [],
      dealer: (Math.random() * 4) | 0,
      turn: 0,
      phase: 'lack',
      lastDiscard: -1,
      fromSeat: -1,
      over: false,
      humanTimer: null,
      roundNo: 1,
      events: []
    };
    var names = G.auto
      ? ['东家 · 阿发', '南家 · 小满', '西家 · 老陈', '北家 · 幺妹']
      : ['你', '下家 · 小满', '对家 · 老陈', '上家 · 幺妹'];
    for (var i = 0; i < 4; i++) {
      G.players.push({
        seat: i,
        name: names[i],
        isHuman: !G.auto && i === 0,
        hand: [],
        melds: [],
        discards: [],
        lack: -1,
        won: false,
        winInfo: null,
        score: 0,
        lastDraw: -1,
        ting: false
      });
    }
    G.wall = R.newWall();
    for (var r = 0; r < 13; r++) {
      for (var p = 0; p < 4; p++) G.players[p].hand.push(G.wall.pop());
    }
    G.players[G.dealer].hand.push(G.wall.pop());
    for (i = 0; i < 4; i++) sortHand(G.players[i].hand);
    G.turn = G.dealer;
    UI.render(G);
    later(phaseLack, 500);
  }

  /* ================= 定缺 ================= */
  function phaseLack() {
    var i;
    for (i = 0; i < 4; i++) {
      var p = G.players[i];
      if (p.isHuman) continue;
      p.lack = AI.chooseLack(R.cntOf(p.hand));
    }
    var human = G.players[0];
    if (human.isHuman) {
      UI.showLack(function (suit) {
        human.lack = suit;
        V.act('dingque');
        UI.render(G);
        later(startPlay, 500);
      });
    } else {
      later(startPlay, 600);
    }
  }

  function startPlay() {
    UI.hideLack();
    G.turn = G.dealer;
    // 庄家已有 14 张，等于刚摸完牌
    later(function () { beginTurn(true); }, 400);
  }

  /* ================= 回合 ================= */
  function activeCount() {
    var n = 0;
    for (var i = 0; i < 4; i++) if (!G.players[i].won) n++;
    return n;
  }

  function nextActive(from) {
    for (var k = 1; k <= 4; k++) {
      var s = (from + k) % 4;
      if (!G.players[s].won) return s;
    }
    return -1;
  }

  function beginTurn(first) {
    if (!G || G.over) return;
    var p = G.players[G.turn];
    if (p.won) {
      var nx = nextActive(G.turn);
      if (nx < 0) { endDraw(); return; }
      G.turn = nx;
      later(function () { beginTurn(false); }, 200);
      return;
    }
    if (!G.wall.length && !first) { endDraw(); return; }

    if (!first) {
      var t = G.wall.pop();
      p.hand.push(t);
      p.lastDraw = t;
      sortHand(p.hand);
      UI.render(G);
    }
    offerSelf(p);
  }

  function selfGangs(p) {
    var cnt = R.cntOf(p.hand);
    var out = [];
    var i;
    for (i = 0; i < 27; i++) {
      if (p.lack >= 0 && R.suitOf(i) === p.lack) continue;
      if (cnt[i] === 4) out.push({ tile: i, type: 'angang' });
    }
    for (i = 0; i < p.melds.length; i++) {
      if (p.melds[i].type === 'peng' && cnt[p.melds[i].tile] > 0) {
        out.push({ tile: p.melds[i].tile, type: 'bugang' });
      }
    }
    return out;
  }

  function canSelfWin(p) {
    var cnt = R.cntOf(p.hand);
    if (AI.hasSuit(cnt, p.lack)) return false;
    return R.canHu(cnt, p.melds.length);
  }

  function offerSelf(p) {
    if (!G || G.over) return;
    var canWin = canSelfWin(p);
    var gangs = selfGangs(p);
    G.phase = 'self';

    if (p.isHuman) {
      if (!canWin && !gangs.length) { askDiscard(p, false); return; }
      UI.showSelfActions(canWin, gangs.length > 0, function (act) {
        UI.hideActions();
        if (act === 'hu') { doWin(0, -1, { zimo: true }); return; }
        if (act === 'gang') {
          if (gangs.length > 1 && UI.chooseGang) {
            UI.chooseGang(gangs, function (pick) { applySelfGang(p, pick); });
          } else {
            applySelfGang(p, gangs[0]);
          }
          return;
        }
        askDiscard(p, canWin);
      });
      return;
    }

    later(function () {
      if (canWin) { doWin(p.seat, -1, { zimo: true }); return; }
      if (gangs.length) {
        var st = { hand: p.hand.slice(0), melds: p.melds, lack: p.lack, tile: gangs[0].tile };
        if (AI.shouldGang(st, gangs[0].type)) { applySelfGang(p, gangs[0]); return; }
      }
      aiDiscard(p);
    }, 420 + Math.random() * 260);
  }

  function applySelfGang(p, g) {
    var n = g.type === 'angang' ? 4 : 1;
    for (var k = 0; k < n; k++) removeOne(p.hand, g.tile);
    if (g.type === 'angang') {
      p.melds.push({ type: 'angang', tile: g.tile });
    } else {
      for (var i = 0; i < p.melds.length; i++) {
        if (p.melds[i].type === 'peng' && p.melds[i].tile === g.tile) {
          p.melds[i] = { type: 'bugang', tile: g.tile };
          break;
        }
      }
    }
    p.lastDraw = -1;
    // 杠分
    var gs = R.gangScore(g.type);
    payGang(p.seat, g.tile, gs, g.type);
    V.act(g.type === 'angang' ? 'angang' : 'bugang');
    addEvent(p.name + (g.type === 'angang' ? ' 暗杠 ' : ' 补杠 ') + R.tileName(g.tile));
    UI.render(G);

    // 杠后摸一张（杠上花）
    if (!G.wall.length) { endDraw(); return; }
    later(function () {
      var t = G.wall.pop();
      p.hand.push(t);
      p.lastDraw = t;
      sortHand(p.hand);
      G.gangFlower = true;
      UI.render(G);
      later(function () {
        var c2 = R.cntOf(p.hand);
        if (!AI.hasSuit(c2, p.lack) && R.canHu(c2, p.melds.length)) {
          if (p.isHuman) {
            UI.showSelfActions(true, false, function (act) {
              UI.hideActions();
              if (act === 'hu') doWin(p.seat, -1, { zimo: true, gangFlower: true });
              else askDiscard(p, true);
            });
          } else {
            doWin(p.seat, -1, { zimo: true, gangFlower: true });
          }
          return;
        }
        var g2 = selfGangs(p);
        if (g2.length) { offerSelf(p); return; }
        if (p.isHuman) askDiscard(p, true); else aiDiscard(p);
      }, 260);
    }, 300);
  }

  function payGang(seat, tile, gs, type) {
    var p = G.players[seat];
    if (gs.single) {
      var payer = G.players[G.fromSeat];
      if (payer && !payer.won && payer.seat !== seat) {
        payer.score -= gs.per;
        p.score += gs.per;
      }
    } else {
      for (var i = 0; i < 4; i++) {
        if (i === seat || G.players[i].won) continue;
        G.players[i].score -= gs.per;
        p.score += gs.per;
      }
    }
  }

  function askDiscard(p, canWin) {
    G.phase = 'discard';
    if (p.isHuman) {
      UI.setDiscardMode(true);
      UI.render(G);
      if (canWin) UI.showSelfActions(true, false, function (act) {
        UI.hideActions();
        if (act === 'hu') doWin(0, -1, { zimo: true, gangFlower: !!G.gangFlower });
      });
      return;
    }
    later(function () { aiDiscard(p); }, 420 + Math.random() * 300);
  }

  function aiDiscard(p) {
    var seen = seenCount();
    var t = AI.chooseDiscard({
      hand: p.hand.slice(0),
      melds: p.melds,
      lack: p.lack,
      seen: seen,
      wallLeft: G.wall.length
    });
    if (t < 0) t = p.hand[0];
    doDiscard(p, t);
  }

  function doDiscard(p, tile) {
    if (!G || G.over) return;
    if (p.seat !== G.turn) return;
    if (!removeOne(p.hand, tile)) return;
    p.lastDraw = -1;
    p.discards.push(tile);
    G.lastDiscard = tile;
    G.fromSeat = p.seat;
    G.gangFlower = false;
    G.phase = 'claim';
    UI.setDiscardMode(false);
    UI.render(G);
    V.tile(tile);
    later(function () { resolveClaims(p.seat, tile); }, 420);
  }

  /* ================= 别人出牌后的响应 ================= */
  function computeClaims(fromSeat, tile) {
    var huSeats = [], gangSeats = [], pengSeats = [];
    var human = null;
    var humanSeat = G.players[0].isHuman ? 0 : -1;

    for (var k = 1; k < 4; k++) {
      var seat = (fromSeat + k) % 4;
      var p = G.players[seat];
      if (p.won) continue;
      var cnt = R.cntOf(p.hand);
      var c = cnt[tile] || 0;
      var canHu = false, canGang = false, canPeng = false;

      if (R.suitOf(tile) !== p.lack) {
        if (!AI.hasSuit(cnt, p.lack)) {
          cnt[tile]++;
          canHu = R.canHu(cnt, p.melds.length);
          cnt[tile]--;
        }
        canGang = c === 3 && p.melds.length < 4;
        canPeng = c >= 2 && p.melds.length < 4;
        if (canGang) gangSeats.push(seat);
        else if (canPeng) pengSeats.push(seat);
      }
      if (canHu) huSeats.push(seat);
      if (seat === humanSeat) {
        human = { seat: 0, canHu: canHu, canGang: canGang, canPeng: canPeng };
      }
    }

    // AI 的碰杠意愿
    var aiGang = [], aiPeng = [], aiHu = [];
    var i, s1, s2, q1, q2;
    for (i = 0; i < gangSeats.length; i++) {
      s1 = gangSeats[i];
      if (s1 === humanSeat) continue;
      q1 = G.players[s1];
      if (AI.shouldGang({ hand: q1.hand.slice(0), melds: q1.melds, lack: q1.lack, tile: tile }, 'gang')) aiGang.push(s1);
    }
    for (i = 0; i < pengSeats.length; i++) {
      s2 = pengSeats[i];
      if (s2 === humanSeat) continue;
      q2 = G.players[s2];
      if (AI.shouldPeng({ hand: q2.hand.slice(0), melds: q2.melds, lack: q2.lack, tile: tile })) aiPeng.push(s2);
    }
    for (i = 0; i < huSeats.length; i++) {
      if (huSeats[i] !== humanSeat) aiHu.push(huSeats[i]);
    }

    return { aiHu: aiHu, aiGang: aiGang, aiPeng: aiPeng, human: human };
  }

  function resolveClaims(fromSeat, tile) {
    if (!G || G.over) return;
    var c = computeClaims(fromSeat, tile);
    G.claimData = { fromSeat: fromSeat, tile: tile, data: c };

    var needHuman = c.human && (c.human.canHu || c.human.canGang || c.human.canPeng);
    if (needHuman) {
      UI.showClaimActions(c.human, function (act) {
        clearTimeout(G.humanTimer);
        G.humanTimer = null;
        UI.hideActions();
        applyClaim(act, fromSeat, tile, c);
      });
      G.humanTimer = setTimeout(function () {
        UI.hideActions();
        applyClaim('pass', fromSeat, tile, c);
      }, 9000);
      return;
    }
    applyClaim('pass', fromSeat, tile, c);
  }

  function applyClaim(act, fromSeat, tile, c) {
    if (!G || G.over) return;

    if (act === 'hu') {
      doWin(0, fromSeat, { tile: tile, chain: true });
      later(function () { afterWinChain(fromSeat, c.aiHu.slice(0), tile); }, 900);
      return;
    }
    // 有人能胡时，碰和杠都要让位
    if ((act === 'gang' || act === 'peng') && c.aiHu.length) {
      afterWinChain(fromSeat, c.aiHu, tile);
      return;
    }
    if (act === 'gang') { doGangFromDiscard(0, tile, fromSeat); return; }
    if (act === 'peng') { doPeng(0, tile, fromSeat); return; }

    if (c.aiHu.length) {
      afterWinChain(fromSeat, c.aiHu, tile);
      return;
    }
    if (c.aiGang.length) { doGangFromDiscard(c.aiGang[0], tile, fromSeat); return; }
    if (c.aiPeng.length) { doPeng(c.aiPeng[0], tile, fromSeat); return; }

    G.turn = (fromSeat + 1) % 4;
    later(function () { beginTurn(false); }, 240);
  }

  // 一炮多响：把还能胡的人依次结算，然后继续血战
  function afterWinChain(fromSeat, remaining, tile) {
    if (remaining.length) {
      var seat = remaining.shift();
      doWin(seat, fromSeat, { tile: tile, chain: true });
      later(function () { afterWinChain(fromSeat, remaining, tile); }, 750);
      return;
    }
    if (activeCount() <= 1) { later(endDraw, 400); return; }
    var nxt = nextActive(G.turn);
    if (nxt < 0) { endDraw(); return; }
    G.turn = nxt;
    later(function () { beginTurn(false); }, 450);
  }

  // 自摸之后：接着往下打
  function proceedAfterWin(seat) {
    G.turn = seat;
    later(function () {
      if (activeCount() <= 1) { endDraw(); return; }
      var nxt = nextActive(seat);
      if (nxt < 0) { endDraw(); return; }
      G.turn = nxt;
      later(function () { beginTurn(false); }, 260);
    }, 900);
  }

  /* ================= 碰 / 杠 / 胡 ================= */
  function doPeng(seat, tile, fromSeat) {
    var p = G.players[seat];
    removeOne(p.hand, tile);
    removeOne(p.hand, tile);
    p.melds.push({ type: 'peng', tile: tile });
    var ds = G.players[fromSeat].discards;
    if (ds.length && ds[ds.length - 1] === tile) ds.pop();
    G.lastDiscard = -1;
    G.fromSeat = fromSeat;
    G.turn = seat;
    V.act('peng');
    addEvent(p.name + ' 碰 ' + R.tileName(tile));
    UI.render(G);
    if (seat === 0) {
      askDiscard(p, false);
    } else {
      later(function () { aiDiscard(p); }, 520);
    }
  }

  function doGangFromDiscard(seat, tile, fromSeat) {
    var p = G.players[seat];
    for (var k = 0; k < 3; k++) removeOne(p.hand, tile);
    p.melds.push({ type: 'gang', tile: tile });
    var ds = G.players[fromSeat].discards;
    if (ds.length && ds[ds.length - 1] === tile) ds.pop();
    G.lastDiscard = -1;
    G.fromSeat = fromSeat;
    G.turn = seat;
    var gs = R.gangScore('gang');
    payGang(seat, tile, gs, 'gang');
    V.act('gang');
    addEvent(p.name + ' 直杠 ' + R.tileName(tile));
    UI.render(G);
    later(function () { drawAfterGang(p); }, 500);
  }

  function drawAfterGang(p) {
    if (!G.wall.length) { endDraw(); return; }
    var t = G.wall.pop();
    p.hand.push(t);
    p.lastDraw = t;
    sortHand(p.hand);
    UI.render(G);
    later(function () {
      var cnt = R.cntOf(p.hand);
      var canWin = !AI.hasSuit(cnt, p.lack) && R.canHu(cnt, p.melds.length);
      if (canWin) {
        if (p.isHuman) {
          UI.showSelfActions(true, false, function (act) {
            UI.hideActions();
            if (act === 'hu') doWin(0, -1, { zimo: true, gangFlower: true });
            else askDiscard(p, true);
          });
        } else {
          doWin(p.seat, -1, { zimo: true, gangFlower: true });
        }
        return;
      }
      var g2 = selfGangs(p);
      if (g2.length) { offerSelf(p); return; }
      if (p.isHuman) askDiscard(p, false); else aiDiscard(p);
    }, 320);
  }

  function doWin(seat, fromSeat, opts) {
    if (!G || G.over) return;
    var p = G.players[seat];
    if (p.won) return;
    opts = opts || {};

    if (fromSeat >= 0) {
      var winTile = (typeof opts.tile === 'number' && opts.tile >= 0) ? opts.tile : G.lastDiscard;
      if (winTile >= 0) {
        var ds = G.players[fromSeat].discards;
        if (ds.length && ds[ds.length - 1] === winTile) ds.pop();
        p.hand.push(winTile);
        sortHand(p.hand);
      }
      G.lastDiscard = -1;
    }
    var cnt = R.cntOf(p.hand);
    var res = R.scoreHand(cnt, p.melds, opts);
    p.won = true;
    p.winInfo = res;
    p.lastDraw = -1;

    if (fromSeat >= 0) {
      var payer = G.players[fromSeat];
      payer.score -= res.score;
      p.score += res.score;
      addEvent(p.name + ' 胡 · ' + res.names.join('+') + ' ' + res.score + '分（点炮：' + payer.name + '）');
    } else {
      for (var i = 0; i < 4; i++) {
        if (i === seat || G.players[i].won) continue;
        G.players[i].score -= res.score;
        p.score += res.score;
      }
      addEvent(p.name + ' 自摸 · ' + res.names.join('+') + ' ' + res.score + '分');
    }
    V.act(opts.zimo ? 'zimo' : 'hu');
    UI.render(G);
    UI.flashWin(p, res);

    if (!opts.chain) proceedAfterWin(seat);
  }

  /* ================= 结束 ================= */
  function isTing(p) {
    var cnt = R.cntOf(p.hand);
    if (AI.hasSuit(cnt, p.lack)) return false;
    return R.waitingTiles(cnt, p.melds.length).length > 0;
  }

  function isHuaZhu(p) {
    return AI.hasSuit(R.cntOf(p.hand), p.lack);
  }

  function endDraw() {
    if (!G || G.over) return;
    G.over = true;
    clearTimers();

    var i, p;
    var notes = [];
    for (i = 0; i < 4; i++) {
      p = G.players[i];
      if (p.won) { p.ting = true; continue; }
      p.huazhu = isHuaZhu(p);
      p.ting = !p.huazhu && isTing(p);
    }
    // 查大叫：未听牌者赔听牌者；花猪赔得更多
    for (i = 0; i < 4; i++) {
      p = G.players[i];
      if (p.won || p.ting) continue;
      var penalty = p.huazhu ? 4 : 2;
      for (var j = 0; j < 4; j++) {
        var q = G.players[j];
        if (j === i || !q.ting || q.won) continue;
        p.score -= penalty;
        q.score += penalty;
        notes.push(p.name + (p.huazhu ? '（花猪）' : '（未听牌）') + ' 赔 ' + q.name + ' ' + penalty + ' 分');
      }
    }
    if (!G.wall.length) V.act('liuju');
    UI.render(G);
    for (i = 0; i < notes.length; i++) addEvent(notes[i]);
    // G.over 已为 true，later 的保护会拦住回调，这里直接用原生定时器
    setTimeout(function () { if (G) UI.showResult(G); }, 900);
  }

  function addEvent(text) {
    if (!G) return;
    G.events.push(text);
    if (G.events.length > 40) G.events.shift();
    UI.updateLog && UI.updateLog(G);
  }

  /* ================= 人类操作入口 ================= */
  function humanDiscard(tile) {
    if (!G || G.over || G.phase !== 'discard') return;
    var p = G.players[0];
    if (G.turn !== 0) return;
    // 缺门硬规则：还有缺门牌时，只能先打缺门
    if (p.lack >= 0) {
      var cnt = R.cntOf(p.hand);
      if (AI.hasSuit(cnt, p.lack) && R.suitOf(tile) !== p.lack) return;
    }
    doDiscard(p, tile);
  }

  function restart(auto) {
    clearTimers();
    UI.hideResult();
    startGame(auto, curLevel);
  }

  global.MJGame = {
    start: startGame,
    restart: restart,
    humanDiscard: humanDiscard,
    get state() { return G; }
  };
})(window);
