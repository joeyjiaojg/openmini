/* 四川血战 · 机器人 AI
 * 出牌：缺门优先 → 向听数最小 → 有效进张最多 → 孤张/边张先走
 * 碰杠：只在不让牌型变差时动，杠有分所以略积极
 * 难度：0 入门（不算进张、没防守、偶尔乱打）
 *       1 进阶（默认策略）
 *       2 高手（全量算进张、更早防炮、更会取舍）
 */
(function (global) {
  'use strict';

  var R = global.MJRule;
  var TOTAL = R.TOTAL;
  var LEVEL = 1; // 0 入门 / 1 进阶 / 2 高手

  function hasSuit(cnt, suit) {
    for (var i = suit * 9; i < suit * 9 + 9; i++) if (cnt[i] > 0) return true;
    return false;
  }

  function countSuit(cnt, suit) {
    var n = 0;
    for (var i = suit * 9; i < suit * 9 + 9; i++) n += cnt[i];
    return n;
  }

  // 某张牌在手里的"孤立程度"：0 最好（有邻有对），越大越该打
  function lonelyScore(cnt, t) {
    var r = R.rankOf(t);
    var s = 0;
    var c = cnt[t];
    if (c === 1) s += 10;
    else if (c === 2) s -= 14;      // 对子是搭子，别拆
    else if (c >= 3) s -= 40;       // 刻子更别拆
    var left = (t % 9 > 0) ? cnt[t - 1] : 0;
    var left2 = (t % 9 > 1) ? cnt[t - 2] : 0;
    var right = (t % 9 < 8) ? cnt[t + 1] : 0;
    var right2 = (t % 9 < 7) ? cnt[t + 2] : 0;
    if (left || right) s -= 8;
    else if (left2 || right2) s -= 3;
    else s += 6;                     // 完全孤张
    if (r === 1 || r === 9) s += 4;  // 边张价值低
    else if (r === 2 || r === 8) s += 1;
    else s -= 1;                     // 中张价值高
    return s;
  }

  function countTiles(c) {
    var s = 0;
    for (var i = 0; i < TOTAL; i++) s += c[i];
    return s;
  }

  // 打掉 t 之后的进张数（剩余张数总和）
  function usefulCount(cnt, meldCount, discard, seen) {
    var work = cnt.slice(0);
    work[discard]--;
    var base = R.shanten(work, meldCount);
    var total = 0;
    for (var t = 0; t < TOTAL; t++) {
      var remain = 4 - work[t] - (seen ? seen[t] : 0);
      if (remain <= 0) continue;
      work[t]++;
      if (R.shanten(work, meldCount) < base) total += remain;
      work[t]--;
    }
    return { shanten: base, useful: total };
  }

  /* 选择出牌
   * st: { hand: [tiles], melds: [...], lack: suit, seen: cnt, wallLeft }
   */
  function chooseDiscard(st) {
    var cnt = R.cntOf(st.hand);
    var meldCount = st.melds.length;
    var lack = st.lack;
    var i, t;

    // 1. 缺门牌必须先打完（硬规则），里面挑最没用的先走
    if (lack >= 0 && hasSuit(cnt, lack)) {
      var bestLack = -1, bestLackScore = -1e9;
      for (i = lack * 9; i < lack * 9 + 9; i++) {
        if (cnt[i] === 0) continue;
        var sc = lonelyScore(cnt, i);
        if (sc > bestLackScore) { bestLackScore = sc; bestLack = i; }
      }
      return bestLack;
    }

    // 2. 先只算向听（便宜的），圈出最优候选
    var all = [];
    for (t = 0; t < TOTAL; t++) {
      if (cnt[t] === 0) continue;
      var w0 = cnt.slice(0);
      w0[t]--;
      all.push({ tile: t, shanten: R.shanten(w0, meldCount) });
    }
    if (!all.length) return -1;

    var minSh = 99;
    for (i = 0; i < all.length; i++) if (all[i].shanten < minSh) minSh = all[i].shanten;

    var pool = [];
    for (i = 0; i < all.length; i++) {
      if (all[i].shanten !== minSh) continue;
      all[i].lonely = lonelyScore(cnt, all[i].tile);
      pool.push(all[i]);
    }
    // 同向听的候选里，先按孤张度排，只对前几个精确算进张
    pool.sort(function (a, b) { return b.lonely - a.lonely; });

    /* ---- 入门：不精确算进张、没防守，偶尔从候选里乱挑一张 ---- */
    if (LEVEL === 0) {
      var top = pool.slice(0, Math.min(5, pool.length));
      if (Math.random() < 0.28) return top[(Math.random() * top.length) | 0].tile;
      // 入门偶尔（12%）连向听都不算最优，从所有牌里按孤张度挑
      if (Math.random() < 0.12) {
        var lazy = all.slice(0).sort(function (a, b) {
          return lonelyScore(cnt, b.tile) - lonelyScore(cnt, a.tile);
        });
        return lazy[0].tile;
      }
      return top[0].tile;
    }

    var poolLimit = LEVEL === 2 ? 12 : 6;
    if (pool.length > poolLimit) pool = pool.slice(0, poolLimit);

    for (i = 0; i < pool.length; i++) {
      var info = usefulCount(cnt, meldCount, pool[i].tile, st.seen);
      pool[i].useful = info.useful;
      // 血战后期：别人打过的牌更安全，没露过面的中张有风险
      var danger = 0;
      var wallLeft = st.wallLeft;
      // 高手更早开始防炮，权重也更大；自己牌烂时专心防守
      var guardFrom = LEVEL === 2 ? 34 : 24;
      if (wallLeft <= guardFrom) {
        var seenN = st.seen ? st.seen[pool[i].tile] : 0;
        var per = LEVEL === 2 ? 1.6 : 1;
        danger = (seenN >= 2 ? -6 : (seenN === 0 ? 8 : 2)) * per;
        if (LEVEL === 2 && info.shanten >= 2 && wallLeft <= 20) danger *= 1.5;
      }
      pool[i].danger = danger;
    }

    pool.sort(function (a, b) {
      if (a.useful !== b.useful) return b.useful - a.useful;
      var sa = a.lonely + (a.danger || 0), sb = b.lonely + (b.danger || 0);
      if (sa !== sb) return sb - sa;
      return a.tile - b.tile;
    });
    return pool[0].tile;
  }

  /* 是否碰
   * st: { hand, melds, lack, tile }
   * 返回 true 表示碰
   */
  function shouldPeng(st) {
    var t = st.tile;
    if (st.lack >= 0 && R.suitOf(t) === st.lack) return false;
    var meldCount = st.melds.length;
    if (meldCount >= 4) return false;

    var cnt = R.cntOf(st.hand);
    if (cnt[t] < 2) return false;

    var before = R.shanten(cnt, meldCount);

    // 碰后手牌 -2 张、副露 +1
    var after = cnt.slice(0);
    after[t] -= 2;
    var afterShanten = R.shanten(after, meldCount + 1);

    if (LEVEL === 0) return afterShanten < before;   // 入门：只有变好才碰
    if (afterShanten < before) return true;
    if (afterShanten > before) return false;
    // 相同时：手上对子多、向听已经不错，可以碰（四川碰了能更快听牌）
    var pairs = 0;
    for (var i = 0; i < TOTAL; i++) if (cnt[i] === 2) pairs++;
    if (LEVEL === 2) return before <= 1 ? pairs <= 4 : pairs >= 2;
    if (before <= 1) return pairs <= 3;
    return pairs >= 3;
  }

  /* 是否杠
   * type: 'angang' | 'gang' | 'bugang'
   */
  function shouldGang(st, type) {
    var t = st.tile;
    if (st.lack >= 0 && R.suitOf(t) === st.lack) return false;
    if (type === 'bugang') return true;   // 补杠不改变牌型，稳赚分
    var cnt = R.cntOf(st.hand);
    var meldCount = st.melds.length;
    var need = type === 'angang' ? 4 : 3;
    if (cnt[t] < need) return false;

    var before = R.shanten(cnt, meldCount);
    var after = cnt.slice(0);
    after[t] -= need;
    var afterShanten = R.shanten(after, meldCount + 1);

    if (LEVEL === 0) return afterShanten < before;   // 入门：只有变好才杠
    if (afterShanten > before) return false;   // 拆坏了不杠
    // 七对牌型别乱杠
    if (meldCount === 0 && R.isSevenPairs(cnt) === false && before >= 2) {
      var pairs = 0;
      for (var i = 0; i < TOTAL; i++) if (cnt[i] === 2) pairs++;
      if (pairs >= 5 && cnt[t] === 4) return false;
    }
    return true;
  }

  function chooseLack(cnt) {
    return R.suggestLack(cnt);
  }

  function setLevel(lv) {
    var v = parseInt(lv, 10);
    LEVEL = (v === 0 || v === 2) ? v : 1;
  }

  global.MJAI = {
    hasSuit: hasSuit,
    countSuit: countSuit,
    chooseDiscard: chooseDiscard,
    shouldPeng: shouldPeng,
    shouldGang: shouldGang,
    chooseLack: chooseLack,
    setLevel: setLevel
  };
})(window);
