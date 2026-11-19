/* 四川血战到底 · 规则引擎
 * 牌编码 0-26：0-8 万(1-9)，9-17 筒(1-9)，18-26 条(1-9)
 * 只用万筒条 108 张，无字牌、不能吃
 */
(function (global) {
  'use strict';

  var SUIT_CH = ['万', '筒', '条'];
  var NUM_CH = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var TOTAL = 27;

  function suitOf(t) { return (t / 9) | 0; }
  function rankOf(t) { return t % 9 + 1; }
  function tileName(t) { return NUM_CH[rankOf(t)] + SUIT_CH[suitOf(t)]; }
  function shortName(t) { return rankOf(t) + SUIT_CH[suitOf(t)]; }

  function emptyCnt() {
    var a = new Array(TOTAL);
    for (var i = 0; i < TOTAL; i++) a[i] = 0;
    return a;
  }
  function cntOf(tiles) {
    var c = emptyCnt();
    for (var i = 0; i < tiles.length; i++) c[tiles[i]]++;
    return c;
  }
  function totalOf(cnt) {
    var s = 0;
    for (var i = 0; i < TOTAL; i++) s += cnt[i];
    return s;
  }

  /* ---------- 牌墙 ---------- */
  function newWall() {
    var wall = [];
    for (var t = 0; t < TOTAL; t++) {
      for (var k = 0; k < 4; k++) wall.push(t);
    }
    // 洗牌
    for (var i = wall.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var tmp = wall[i]; wall[i] = wall[j]; wall[j] = tmp;
    }
    return wall;
  }

  /* ---------- 胡牌判定 ---------- */
  // 拆成 4 组面子（顺/刻）+ 一对将；cnt 会被临时修改但保证复原
  function splitMelds(cnt, sets) {
    var i = 0;
    while (i < TOTAL && cnt[i] === 0) i++;
    if (i >= TOTAL) return true;
    if (cnt[i] >= 3) {
      cnt[i] -= 3;
      sets.push({ type: 'ke', tile: i });
      if (splitMelds(cnt, sets)) { cnt[i] += 3; return true; }
      sets.pop();
      cnt[i] += 3;
    }
    if (rankOf(i) <= 7 && cnt[i + 1] > 0 && cnt[i + 2] > 0) {
      cnt[i]--; cnt[i + 1]--; cnt[i + 2]--;
      sets.push({ type: 'shun', tile: i });
      if (splitMelds(cnt, sets)) { cnt[i]++; cnt[i + 1]++; cnt[i + 2]++; return true; }
      sets.pop();
      cnt[i]++; cnt[i + 1]++; cnt[i + 2]++;
    }
    return false;
  }

  // 尝试所有将牌，返回第一种可行分解 {sets, pair}
  function decompose(cnt) {
    var work = cnt.slice(0);
    for (var p = 0; p < TOTAL; p++) {
      if (work[p] < 2) continue;
      work[p] -= 2;
      var sets = [];
      if (splitMelds(work, sets)) {
        work[p] += 2;
        return { sets: sets, pair: p };
      }
      work[p] += 2;
    }
    return null;
  }

  function isSevenPairs(cnt) {
    var pairs = 0, kinds = 0;
    for (var i = 0; i < TOTAL; i++) {
      if (cnt[i] === 0) continue;
      kinds++;
      if (cnt[i] % 2 !== 0) return false;
      pairs += cnt[i] / 2;
    }
    return pairs === 7 && kinds >= 4;
  }

  // 手牌（不含副露）是否成胡：melds 为副露数
  function canHu(cnt, meldCount) {
    var n = totalOf(cnt);
    if (n !== 14 - 3 * meldCount) return false;
    if (meldCount === 0 && isSevenPairs(cnt)) return true;
    return !!decompose(cnt);
  }

  // 听哪些牌
  function waitingTiles(cnt, meldCount) {
    var out = [];
    for (var t = 0; t < TOTAL; t++) {
      if (cnt[t] >= 4) continue;
      cnt[t]++;
      if (canHu(cnt, meldCount)) out.push(t);
      cnt[t]--;
    }
    return out;
  }

  /* ---------- 向听数 ---------- */
  var SH_CACHE = {};
  var SH_CACHE_N = 0;

  function shantenKey(cnt, meldCount) {
    var s = '';
    for (var i = 0; i < TOTAL; i++) s += String.fromCharCode(48 + cnt[i]);
    return s + meldCount;
  }

  function stdShanten(cnt, meldCount) {
    var best = 99;
    function rec(i, melds, partials, pairUsed) {
      if (i >= TOTAL) {
        var m = melds + meldCount;
        var t = partials;
        if (m + t > 4) t = 4 - m;
        if (t < 0) t = 0;
        var sh = 8 - 2 * m - t - (pairUsed ? 1 : 0);
        if (sh < best) best = sh;
        return;
      }
      if (cnt[i] === 0) { rec(i + 1, melds, partials, pairUsed); return; }
      var c = cnt[i];

      if (c >= 3) {
        cnt[i] -= 3;
        rec(i, melds + 1, partials, pairUsed);
        cnt[i] += 3;
      }
      if (rankOf(i) <= 7 && cnt[i + 1] > 0 && cnt[i + 2] > 0) {
        cnt[i]--; cnt[i + 1]--; cnt[i + 2]--;
        rec(i, melds + 1, partials, pairUsed);
        cnt[i]++; cnt[i + 1]++; cnt[i + 2]++;
      }
      if (melds + partials < 4 + meldCount) {
        if (c >= 2) {
          cnt[i] -= 2;
          if (!pairUsed) rec(i, melds, partials, true);
          rec(i, melds, partials + 1, pairUsed);
          cnt[i] += 2;
        }
        if (rankOf(i) <= 8 && cnt[i + 1] > 0) {
          cnt[i]--; cnt[i + 1]--;
          rec(i, melds, partials + 1, pairUsed);
          cnt[i]++; cnt[i + 1]++;
        }
        if (rankOf(i) <= 7 && cnt[i + 2] > 0) {
          cnt[i]--; cnt[i + 2]--;
          rec(i, melds, partials + 1, pairUsed);
          cnt[i]++; cnt[i + 2]++;
        }
      }
      cnt[i]--;
      rec(i, melds, partials, pairUsed);
      cnt[i]++;
    }
    rec(0, 0, 0, false);
    return best;
  }

  function shanten(cnt, meldCount) {
    var key = shantenKey(cnt, meldCount);
    var hit = SH_CACHE[key];
    if (hit !== undefined) return hit;
    var best = stdShanten(cnt, meldCount);
    if (meldCount === 0) {
      var pairs = 0, kinds = 0;
      for (var i = 0; i < TOTAL; i++) {
        if (cnt[i] >= 2) pairs++;
        if (cnt[i] > 0) kinds++;
      }
      var sp = 6 - pairs + Math.max(0, 7 - kinds);
      if (sp < best) best = sp;
    }
    if (SH_CACHE_N < 120000) { SH_CACHE[key] = best; SH_CACHE_N++; }
    return best;
  }

  /* ---------- 番型 ---------- */
  function isQingYiSe(tiles) {
    if (!tiles.length) return false;
    var s = suitOf(tiles[0]);
    for (var i = 1; i < tiles.length; i++) if (suitOf(tiles[i]) !== s) return false;
    return true;
  }

  function isPengPeng(cnt) {
    var pairs = 0;
    for (var i = 0; i < TOTAL; i++) {
      var c = cnt[i];
      if (c === 0) continue;
      if (c === 2) pairs++;
      else if (c !== 3) return false;
    }
    return pairs === 1;
  }

  function isJiangJiang(cnt) {
    // 全将：所有牌都是 2/5/8
    for (var i = 0; i < TOTAL; i++) {
      if (cnt[i] === 0) continue;
      var r = rankOf(i);
      if (r !== 2 && r !== 5 && r !== 8) return false;
    }
    return true;
  }

  function hasYaoJiu(sets, pair) {
    var i, r;
    if (!sets) return false;
    r = rankOf(pair);
    if (r !== 1 && r !== 9) return false;
    for (i = 0; i < sets.length; i++) {
      r = rankOf(sets[i].tile);
      if (sets[i].type === 'ke') {
        if (r !== 1 && r !== 9) return false;
      } else {
        if (r !== 1 && r !== 7) return false;
      }
    }
    return true;
  }

  /* 计算番型
   * ctx: { zimo, gangFlower(杠上花), qiangGang(抢杠胡), haidi(海底捞月) }
   * handCnt: 手牌计数（不含副露）
   * melds: [{type:'peng'|'gang'|'angang'|'bugang', tile}]
   */
  function scoreHand(handCnt, melds, ctx) {
    ctx = ctx || {};
    var allTiles = [];
    var i, j;
    for (i = 0; i < TOTAL; i++) for (j = 0; j < handCnt[i]; j++) allTiles.push(i);
    for (i = 0; i < melds.length; i++) {
      var n = melds[i].type === 'peng' ? 3 : 4;
      for (j = 0; j < n; j++) allTiles.push(melds[i].tile);
    }

    var names = [];
    var fan = 1;
    var seven = melds.length === 0 && isSevenPairs(handCnt);
    var longSeven = false;
    if (seven) {
      for (i = 0; i < TOTAL; i++) if (handCnt[i] === 4) longSeven = true;
    }
    var qing = isQingYiSe(allTiles);
    var peng = false;
    var dec = null;
    if (!seven) {
      dec = decompose(handCnt);
      peng = isPengPeng(handCnt);
    }
    var jiang = isJiangJiang(handCnt);
    var handCount = totalOf(handCnt);
    var jingou = false; // 金钩钓：手上只剩一张单吊，全靠副露

    if (seven) {
      fan = Math.max(fan, longSeven ? 3 : 2);
      names.push(longSeven ? '龙七对' : '七对');
    }
    if (peng) { fan = Math.max(fan, 2); names.push('对对胡'); }
    if (qing) { fan = Math.max(fan, 2); names.push('清一色'); }
    if (qing && peng) { fan = Math.max(fan, 3); names.push('清对'); }
    if (qing && seven && longSeven) { fan = Math.max(fan, 4); names.push('清龙七对'); }
    else if (qing && seven) { fan = Math.max(fan, 3); names.push('清七对'); }
    if (handCount === 2 && melds.length > 0) {
      // 只剩一对将、四副副露 → 金钩钓
      jingou = true;
      fan = Math.max(fan, 2);
      names.push('金钩钓');
    }
    if (jiang && fan < 2) { names.push('全将'); }
    if (!seven && dec && hasYaoJiu(dec.sets, dec.pair) && !jingou) {
      fan += 1;
      names.push('带幺九');
    }
    if (ctx.gangFlower) { fan += 1; names.push('杠上花'); }
    if (ctx.qiangGang) { fan += 1; names.push('抢杠胡'); }
    if (ctx.haidi) { fan += 1; names.push('海底捞月'); }
    if (fan > 6) fan = 6;

    if (names.length === 0) names.push('平胡');
    var score = 1;
    for (i = 1; i < fan; i++) score *= 2;

    return { fan: fan, score: score, names: names };
  }

  /* ---------- 杠分 ---------- */
  // 暗杠每家 2 分，直杠点杠者 2 分，补杠每家 1 分
  function gangScore(type) {
    if (type === 'angang') return { per: 2, single: false };
    if (type === 'gang') return { per: 2, single: true };
    return { per: 1, single: false };
  }

  /* ---------- 定缺推荐（AI 也用） ---------- */
  function suggestLack(cnt) {
    var counts = [0, 0, 0];
    var i;
    for (i = 0; i < TOTAL; i++) counts[suitOf(i)] += cnt[i];
    var best = 0, bestScore = 1e9;
    for (var s = 0; s < 3; s++) {
      // 张数越少越该缺；同数量时看搭子质量
      var score = counts[s] * 100;
      // 有对子/刻子则该门舍不得
      for (i = s * 9; i < s * 9 + 9; i++) {
        if (cnt[i] >= 3) score += 60;
        else if (cnt[i] === 2) score += 30;
      }
      // 相邻搭子
      for (i = s * 9; i < s * 9 + 8; i++) {
        if (cnt[i] > 0 && cnt[i + 1] > 0) score -= 12;
      }
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  global.MJRule = {
    SUIT_CH: SUIT_CH,
    NUM_CH: NUM_CH,
    TOTAL: TOTAL,
    suitOf: suitOf,
    rankOf: rankOf,
    tileName: tileName,
    shortName: shortName,
    emptyCnt: emptyCnt,
    cntOf: cntOf,
    totalOf: totalOf,
    newWall: newWall,
    canHu: canHu,
    decompose: decompose,
    isSevenPairs: isSevenPairs,
    waitingTiles: waitingTiles,
    shanten: shanten,
    scoreHand: scoreHand,
    gangScore: gangScore,
    suggestLack: suggestLack
  };
})(window);
