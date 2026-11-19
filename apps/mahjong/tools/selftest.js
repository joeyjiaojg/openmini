/* 规则引擎自测（Node 下跑：node tools/selftest.js） */
'use strict';
global.window = global;
require('../js/rule.js');
require('../js/ai.js');

var R = global.MJRule, AI = global.MJAI;
var fail = 0, pass = 0;

function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) {
  if (a === b) { pass++; }
  else { fail++; console.log('  ✗ ' + msg + ' (got ' + a + ', want ' + b + ')'); }
}

function hasSuit(cnt, suit) {
  for (var i = suit * 9; i < suit * 9 + 9; i++) if (cnt[i] > 0) return true;
  return false;
}

/* ---------- 胡牌判定 ---------- */
console.log('胡牌判定');
// 111万 234万 456万 999万 11筒
var h1 = R.cntOf([0, 0, 0, 1, 2, 3, 3, 4, 5, 8, 8, 8, 9, 9]);
ok(R.canHu(h1, 0), '标准型 4 面子 + 将');
// 缺一张
var h2 = R.cntOf([0, 0, 0, 1, 2, 3, 3, 4, 5, 8, 8, 8, 9]);
ok(!R.canHu(h2, 0), '13 张不该判胡');
// 七对
var h3 = R.cntOf([0, 0, 1, 1, 2, 2, 3, 3, 9, 9, 10, 10, 18, 18]);
ok(R.canHu(h3, 0), '七对');
ok(R.isSevenPairs(h3), '七对识别');
// 龙七对
var h4 = R.cntOf([0, 0, 0, 0, 1, 1, 2, 2, 9, 9, 10, 10, 18, 18]);
ok(R.canHu(h4, 0), '龙七对');
// 不是胡：乱牌
var h5 = R.cntOf([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26]);
ok(!R.canHu(h5, 0), '散牌不该胡');
// 副露
var h6 = R.cntOf([0, 0, 0, 1, 2, 3, 9, 9]);
ok(R.canHu(h6, 2), '两副露 + 8 张手牌');

/* ---------- 听牌 ---------- */
console.log('听牌');
var t1 = R.cntOf([0, 0, 0, 1, 2, 3, 3, 4, 5, 8, 8, 8, 9]);
var w = R.waitingTiles(t1, 0);
eq(w.length, 1, '单吊听一张');
eq(w[0], 9, '听的是 1 筒');

/* ---------- 向听 ---------- */
console.log('向听数');
eq(R.shanten(t1, 0), 0, '听牌 = 0 向听');
var t2 = R.cntOf([0, 1, 2, 4, 5, 6, 9, 10, 11, 13, 14, 15, 18]);
eq(R.shanten(t2, 0), 0, '两面听 = 0 向听');
var t3 = R.cntOf([0, 2, 4, 6, 8, 9, 11, 13, 15, 17, 18, 20, 22]);
ok(R.shanten(t3, 0) >= 4, '散牌向听很大');

/* ---------- 番型 ---------- */
console.log('番型');
var qingdui = R.cntOf([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4]);
var r1 = R.scoreHand(qingdui, [], {});
ok(r1.fan >= 3, '清对至少 3 番（实得 ' + r1.fan + '：' + r1.names.join('+') + '）');

var qidui = R.cntOf([0, 0, 1, 1, 2, 2, 3, 3, 9, 9, 10, 10, 18, 18]);
var r2 = R.scoreHand(qidui, [], {});
eq(r2.fan, 2, '七对 2 番');

var longqi = R.cntOf([0, 0, 0, 0, 1, 1, 2, 2, 9, 9, 10, 10, 18, 18]);
var r3 = R.scoreHand(longqi, [], {});
eq(r3.fan, 3, '龙七对 3 番');

var ping = R.cntOf([0, 0, 0, 1, 2, 3, 3, 4, 5, 9, 10, 11, 18, 18]);
var r4 = R.scoreHand(ping, [], {});
eq(r4.fan, 1, '平胡 1 番');

var gf = R.scoreHand(ping, [], { gangFlower: true });
eq(gf.fan, 2, '杠上花 +1 番');

/* ---------- 定缺建议 ---------- */
console.log('定缺');
var lackHand = R.cntOf([0, 1, 2, 3, 4, 9, 10, 11, 18, 19, 20, 21, 22]);
eq(R.suggestLack(lackHand), 1, '筒子最少应缺筒');

/* ---------- AI 出牌合法性 + 模拟对局（三个难度都要跑） ---------- */
console.log('模拟对局');
var badCases = 0, huTotal = 0, games = 60;
for (var lv = 0; lv < 3; lv++) {
  AI.setLevel(lv);
  var lvHu = 0;
  for (var g = 0; g < games; g++) {
    var wall = R.newWall();
    var hands = [[], [], [], []];
    var i, p;
    for (i = 0; i < 13; i++) for (p = 0; p < 4; p++) hands[p].push(wall.pop());
    var lacks = [];
    for (p = 0; p < 4; p++) lacks.push(R.suggestLack(R.cntOf(hands[p])));
    var turn = 0, steps = 0;

    while (wall.length > 0 && steps < 400) {
      var hand = hands[turn];
      hand.push(wall.pop());
      var cnt = R.cntOf(hand);
      if (!hasSuit(cnt, lacks[turn]) && R.canHu(cnt, 0)) {
        lvHu++;
        hand.pop();               // 模拟胡了就退出，手牌恢复 13 张
        hand.push(wall.length ? wall.pop() : hand[0]);
      }
      var seen = R.emptyCnt();
      var tile = AI.chooseDiscard({
        hand: hand.slice(0), melds: [], lack: lacks[turn],
        seen: seen, wallLeft: wall.length
      });
      if (tile < 0 || hand.indexOf(tile) < 0) { badCases++; break; }
      hand.splice(hand.indexOf(tile), 1);
      if (hand.length !== 13) { badCases++; break; }
      turn = (turn + 1) % 4;
      steps++;
    }
    if (steps >= 400) badCases++;
  }
  console.log('  难度 ' + lv + '：' + games + ' 局，胡 ' + lvHu + ' 次');
  huTotal += lvHu;
}
eq(badCases, 0, '三档难度共 ' + games * 3 + ' 局模拟无非法出牌');
ok(huTotal > 0, '模拟中出现了胡牌（' + huTotal + ' 次）');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
