(function(){
var __cache={};
function __define(id, factory){ __cache[id]={factory:factory, module:null}; }
function __require(name){
  var key=String(name).replace(/.*\//,"").replace(/\.js$/,"");
  var e=__cache[key];
  if(!e) throw new Error("module not found: "+key+" (from "+name+")");
  if(!e.module){ e.module={exports:{}}; e.factory(e.module, e.module.exports, __require); }
  return e.module.exports;
}
window.XQ={require:__require};
__define("xiangqi", function(module, exports, require){
'use strict';

// 中国象棋规则引擎：棋盘为 90 长度一维数组，index = row * 9 + col
// row 0 在上方（黑方底线），row 9 在下方（红方底线）
var EMPTY = 0;
var RED = 0;
var BLACK = 1;
var K = 1; // 将帅
var A = 2; // 士仕
var B = 3; // 象相
var N = 4; // 马
var R = 5; // 车
var C = 6; // 炮
var P = 7; // 兵卒

var PIECE_NAME = {
  1: { 0: '帅', 1: '将' },
  2: { 0: '仕', 1: '士' },
  3: { 0: '相', 1: '象' },
  4: { 0: '马', 1: '马' },
  5: { 0: '车', 1: '车' },
  6: { 0: '炮', 1: '炮' },
  7: { 0: '兵', 1: '卒' }
};

var CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function piece(side, type) {
  return side === RED ? type : type + 8;
}

function sideOf(p) {
  if (!p) return -1;
  return p < 8 ? RED : BLACK;
}

function typeOf(p) {
  return p & 7;
}

function other(side) {
  return side === RED ? BLACK : RED;
}

function inBoard(r, c) {
  return r >= 0 && r < 10 && c >= 0 && c < 9;
}

function idx(r, c) {
  return r * 9 + c;
}

function initialBoard() {
  var b = new Array(90).fill(EMPTY);
  var back = [R, N, B, A, K, A, B, N, R];
  for (var c = 0; c < 9; c++) {
    b[idx(0, c)] = piece(BLACK, back[c]);
    b[idx(9, c)] = piece(RED, back[c]);
  }
  b[idx(2, 1)] = piece(BLACK, C);
  b[idx(2, 7)] = piece(BLACK, C);
  b[idx(7, 1)] = piece(RED, C);
  b[idx(7, 7)] = piece(RED, C);
  var pawnCols = [0, 2, 4, 6, 8];
  for (var i = 0; i < pawnCols.length; i++) {
    b[idx(3, pawnCols[i])] = piece(BLACK, P);
    b[idx(6, pawnCols[i])] = piece(RED, P);
  }
  return b;
}

function cloneBoard(board) {
  return board.slice();
}

function findGeneral(board, side) {
  var target = piece(side, K);
  for (var i = 0; i < 90; i++) {
    if (board[i] === target) return i;
  }
  return -1;
}

var RAYS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
var HORSE_STEPS = [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2]];
var ELEPHANT_STEPS = [[-2, -2], [-2, 2], [2, -2], [2, 2]];

// 目标格是否被 bySide 方攻击（只依赖棋盘，不依赖走子方）
function isAttacked(board, target, bySide) {
  var tr = (target / 9) | 0;
  var tc = target % 9;
  var r, c, p, i;

  // 车、炮、白脸将（同列无遮挡的将帅互相攻击）
  for (i = 0; i < 4; i++) {
    r = tr + RAYS[i][0];
    c = tc + RAYS[i][1];
    var screen = false;
    while (inBoard(r, c)) {
      p = board[idx(r, c)];
      if (p) {
        if (!screen) {
          var tp = typeOf(p);
          if (sideOf(p) === bySide && tp === R) return true;
          if (sideOf(p) === bySide && tp === K && RAYS[i][0] !== 0) return true;
          screen = true;
        } else {
          if (sideOf(p) === bySide && typeOf(p) === C) return true;
          break;
        }
      }
      r += RAYS[i][0];
      c += RAYS[i][1];
    }
  }

  // 马：从目标格反推马位，并检查马腿
  var enemyHorse = piece(bySide, N);
  for (i = 0; i < HORSE_STEPS.length; i++) {
    var hr = tr + HORSE_STEPS[i][0];
    var hc = tc + HORSE_STEPS[i][1];
    if (!inBoard(hr, hc) || board[idx(hr, hc)] !== enemyHorse) continue;
    var leg;
    if (Math.abs(HORSE_STEPS[i][0]) === 2) {
      leg = idx(tr + (HORSE_STEPS[i][0] > 0 ? 1 : -1), hc);
    } else {
      leg = idx(hr, tc + (HORSE_STEPS[i][1] > 0 ? 1 : -1));
    }
    if (board[leg] === EMPTY) return true;
  }

  // 兵卒：前方一格，以及过河后的横向一格
  var enemyPawn = piece(bySide, P);
  if (bySide === BLACK) {
    if (tr > 0 && board[idx(tr - 1, tc)] === enemyPawn) return true;
    if (tc > 0 && board[idx(tr, tc - 1)] === enemyPawn && tr >= 5) return true;
    if (tc < 8 && board[idx(tr, tc + 1)] === enemyPawn && tr >= 5) return true;
  } else {
    if (tr < 9 && board[idx(tr + 1, tc)] === enemyPawn) return true;
    if (tc > 0 && board[idx(tr, tc - 1)] === enemyPawn && tr <= 4) return true;
    if (tc < 8 && board[idx(tr, tc + 1)] === enemyPawn && tr <= 4) return true;
  }

  // 士：斜一格，且在其九宫内
  var enemyAdvisor = piece(bySide, A);
  var palaceMin = bySide === RED ? 7 : 0;
  var palaceMax = bySide === RED ? 9 : 2;
  var diag = DIAG;
  for (i = 0; i < diag.length; i++) {
    var ar = tr + diag[i][0];
    var ac = tc + diag[i][1];
    if (inBoard(ar, ac) && ar >= palaceMin && ar <= palaceMax && ac >= 3 && ac <= 5 && board[idx(ar, ac)] === enemyAdvisor) return true;
  }

  // 将帅：正交一格（白脸将已在上面按同列无遮挡处理）
  var enemyGeneral = piece(bySide, K);
  for (i = 0; i < 4; i++) {
    var gr = tr + RAYS[i][0];
    var gc = tc + RAYS[i][1];
    if (inBoard(gr, gc) && board[idx(gr, gc)] === enemyGeneral) return true;
  }

  // 象相：田字格，象眼为空，且未过河
  var enemyElephant = piece(bySide, B);
  for (i = 0; i < ELEPHANT_STEPS.length; i++) {
    var er = tr + ELEPHANT_STEPS[i][0];
    var ec = tc + ELEPHANT_STEPS[i][1];
    if (!inBoard(er, ec)) continue;
    var ownSide = bySide === RED ? er >= 5 : er <= 4;
    if (!ownSide) continue;
    var eyeR = tr + ELEPHANT_STEPS[i][0] / 2;
    var eyeC = tc + ELEPHANT_STEPS[i][1] / 2;
    if (board[idx(eyeR, eyeC)] === EMPTY && board[idx(er, ec)] === enemyElephant) return true;
  }

  return false;
}

function isInCheck(board, side) {
  var g = findGeneral(board, side);
  if (g < 0) return true;
  return isAttacked(board, g, other(side));
}

// 生成伪合法走法，编码为 from * 256 + to
function generatePseudoMoves(board, side, capturesOnly) {
  var moves = [];
  var us = side;
  for (var from = 0; from < 90; from++) {
    var p = board[from];
    if (!p || sideOf(p) !== us) continue;
    var fr = (from / 9) | 0;
    var fc = from % 9;
    var type = typeOf(p);
    var r, c, to, q, i;

    if (type === R || type === C) {
      for (i = 0; i < 4; i++) {
        r = fr + RAYS[i][0];
        c = fc + RAYS[i][1];
        var hasScreen = false;
        while (inBoard(r, c)) {
          to = idx(r, c);
          q = board[to];
          if (!q) {
            if (!hasScreen && !capturesOnly) moves.push(from * 256 + to);
          } else if (!hasScreen) {
            if (type === R) {
              if (sideOf(q) !== us) moves.push(from * 256 + to);
              break;
            }
            hasScreen = true;
          } else {
            if (sideOf(q) !== us) moves.push(from * 256 + to);
            break;
          }
          r += RAYS[i][0];
          c += RAYS[i][1];
        }
      }
    } else if (type === N) {
      for (i = 0; i < HORSE_STEPS.length; i++) {
        r = fr + HORSE_STEPS[i][0];
        c = fc + HORSE_STEPS[i][1];
        if (!inBoard(r, c)) continue;
        var leg;
        if (Math.abs(HORSE_STEPS[i][0]) === 2) {
          leg = idx(fr + (HORSE_STEPS[i][0] > 0 ? 1 : -1), fc);
        } else {
          leg = idx(fr, fc + (HORSE_STEPS[i][1] > 0 ? 1 : -1));
        }
        if (board[leg] !== EMPTY) continue;
        to = idx(r, c);
        q = board[to];
        if (!q) {
          if (!capturesOnly) moves.push(from * 256 + to);
        } else if (sideOf(q) !== us) {
          moves.push(from * 256 + to);
        }
      }
    } else if (type === B) {
      for (i = 0; i < ELEPHANT_STEPS.length; i++) {
        r = fr + ELEPHANT_STEPS[i][0];
        c = fc + ELEPHANT_STEPS[i][1];
        if (!inBoard(r, c)) continue;
        if (us === RED ? r < 5 : r > 4) continue;
        var eye = idx(fr + ELEPHANT_STEPS[i][0] / 2, fc + ELEPHANT_STEPS[i][1] / 2);
        if (board[eye] !== EMPTY) continue;
        to = idx(r, c);
        q = board[to];
        if (!q) {
          if (!capturesOnly) moves.push(from * 256 + to);
        } else if (sideOf(q) !== us) {
          moves.push(from * 256 + to);
        }
      }
    } else if (type === A || type === K) {
      var dirs = type === A ? DIAG : RAYS;
      var minRow = type === A ? (us === RED ? 7 : 0) : (us === RED ? 7 : 0);
      var maxRow = type === A ? (us === RED ? 9 : 2) : (us === RED ? 9 : 2);
      for (i = 0; i < dirs.length; i++) {
        r = fr + dirs[i][0];
        c = fc + dirs[i][1];
        if (!inBoard(r, c) || c < 3 || c > 5 || r < minRow || r > maxRow) continue;
        to = idx(r, c);
        q = board[to];
        if (!q) {
          if (!capturesOnly) moves.push(from * 256 + to);
        } else if (sideOf(q) !== us) {
          moves.push(from * 256 + to);
        }
      }
      // 白脸将：同一列且中间无子时，将帅可以直接吃掉对方将帅
      if (type === K) {
        var enemyGeneral = piece(other(us), K);
        var step = us === RED ? -1 : 1;
        r = fr + step;
        while (inBoard(r, fc)) {
          q = board[idx(r, fc)];
          if (q) {
            if (q === enemyGeneral) moves.push(from * 256 + idx(r, fc));
            break;
          }
          r += step;
        }
      }
    } else if (type === P) {
      var forward = us === RED ? -1 : 1;
      var targets = [[fr + forward, fc]];
      var crossed = us === RED ? fr <= 4 : fr >= 5;
      if (crossed) {
        targets.push([fr, fc - 1]);
        targets.push([fr, fc + 1]);
      }
      for (i = 0; i < targets.length; i++) {
        r = targets[i][0];
        c = targets[i][1];
        if (!inBoard(r, c)) continue;
        to = idx(r, c);
        q = board[to];
        if (!q) {
          if (!capturesOnly) moves.push(from * 256 + to);
        } else if (sideOf(q) !== us) {
          moves.push(from * 256 + to);
        }
      }
    }
  }
  return moves;
}

function makeMove(board, move) {
  var from = move >> 8;
  var to = move & 255;
  var captured = board[to];
  board[to] = board[from];
  board[from] = EMPTY;
  return captured;
}

function unmakeMove(board, move, captured) {
  var from = move >> 8;
  var to = move & 255;
  board[from] = board[to];
  board[to] = captured;
}

// 过滤掉使己方将帅处于被攻击状态的走法
function generateMoves(board, side, capturesOnly) {
  var pseudo = generatePseudoMoves(board, side, !!capturesOnly);
  var legal = [];
  for (var i = 0; i < pseudo.length; i++) {
    var m = pseudo[i];
    var captured = makeMove(board, m);
    if (!isInCheck(board, side)) legal.push(m);
    unmakeMove(board, m, captured);
  }
  return legal;
}

function gameStatus(board, sideToMove) {
  if (findGeneral(board, sideToMove) < 0) {
    return { over: true, winner: other(sideToMove), reason: 'general', moves: [] };
  }
  var moves = generateMoves(board, sideToMove);
  if (moves.length) return { over: false, winner: -1, reason: '', moves: moves };
  return {
    over: true,
    winner: other(sideToMove),
    reason: isInCheck(board, sideToMove) ? 'checkmate' : 'stalemate',
    moves: []
  };
}

function fileNumber(col, side) {
  return side === RED ? 9 - col : col + 1;
}

// 中文记谱：炮二平五、马8进7 等
function moveToChinese(board, move, side) {
  var from = move >> 8;
  var to = move & 255;
  var p = board[from];
  var type = typeOf(p);
  var name = PIECE_NAME[type][side];
  var fr = (from / 9) | 0;
  var fc = from % 9;
  var tr = (to / 9) | 0;
  var tc = to % 9;
  var sameFile = -1;
  for (var i = 0; i < 90; i++) {
    if (i !== from && board[i] === p && i % 9 === fc) {
      sameFile = i;
      break;
    }
  }
  var label;
  if (sameFile >= 0) {
    var otherRow = (sameFile / 9) | 0;
    var front = side === RED ? fr < otherRow : fr > otherRow;
    label = (front ? '前' : '后') + name;
  } else {
    label = name + CN_NUM[fileNumber(fc, side)];
  }
  if (tr === fr) {
    return label + '平' + CN_NUM[fileNumber(tc, side)];
  }
  var advancing = side === RED ? tr < fr : tr > fr;
  var action = advancing ? '进' : '退';
  var target;
  // 马、相、士记目标纵线；车、炮、兵、将记行进步数
  if (type === N || type === A || type === B) {
    target = CN_NUM[fileNumber(tc, side)];
  } else {
    target = CN_NUM[Math.abs(tr - fr)];
  }
  return label + action + target;
}

module.exports = {
  EMPTY: EMPTY,
  RED: RED,
  BLACK: BLACK,
  K: K, A: A, B: B, N: N, R: R, C: C, P: P,
  PIECE_NAME: PIECE_NAME,
  CN_NUM: CN_NUM,
  piece: piece,
  sideOf: sideOf,
  typeOf: typeOf,
  other: other,
  idx: idx,
  inBoard: inBoard,
  initialBoard: initialBoard,
  cloneBoard: cloneBoard,
  findGeneral: findGeneral,
  isAttacked: isAttacked,
  isInCheck: isInCheck,
  generatePseudoMoves: generatePseudoMoves,
  generateMoves: generateMoves,
  makeMove: makeMove,
  unmakeMove: unmakeMove,
  gameStatus: gameStatus,
  moveToChinese: moveToChinese
};

});
__define("ai", function(module, exports, require){
'use strict';

var X = require('./xiangqi.js');

var INF = 1000000000;
var MATE = 100000;

var VALUE = {};
VALUE[X.K] = 100000;
VALUE[X.R] = 900;
VALUE[X.C] = 500;
VALUE[X.N] = 450;
VALUE[X.A] = 180;
VALUE[X.B] = 180;
VALUE[X.P] = 100;

function makePst(fn) {
  var table = new Array(90);
  for (var r = 0; r < 10; r++) {
    for (var c = 0; c < 9; c++) table[X.idx(r, c)] = fn(r, c);
  }
  return table;
}

var PST = {};
PST[X.P] = makePst(function (r, c) {
  var advance = [0, 0, 0, 0, 0, 30, 65, 105, 155, 210][r];
  var center = (c === 3 || c === 4) ? 16 : (c === 2 || c === 5 ? 8 : 0);
  return advance + center;
});
PST[X.N] = makePst(function (r, c) {
  return 24 - Math.abs(r - 5) * 5 - Math.abs(c - 4) * 4;
});
PST[X.R] = makePst(function (r, c) {
  return (r <= 4 ? 22 : 0) + (c === 3 || c === 4 ? 6 : 0);
});
PST[X.C] = makePst(function (r, c) {
  return (r <= 3 ? 18 : 0) + (c === 3 || c === 4 ? 5 : 0);
});
PST[X.A] = makePst(function (r, c) {
  return r >= 7 ? 6 : -12;
});
PST[X.B] = makePst(function (r, c) {
  return r >= 7 ? 6 : -12;
});
PST[X.K] = makePst(function (r, c) {
  return (r >= 8 && c >= 3 && c <= 5) ? 8 : -25;
});

// Zobrist：使用固定种子的伪随机数，保证同一局面键稳定
function makeRng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

var rng = makeRng(20261118);
var ZOBRIST = new Array(16 * 90);
for (var zi = 0; zi < ZOBRIST.length; zi++) ZOBRIST[zi] = [rng(), rng()];
var Z_SIDE = [rng(), rng()];

function hashBoard(board, side) {
  var h0 = 0;
  var h1 = 0;
  for (var i = 0; i < 90; i++) {
    var p = board[i];
    if (p) {
      var k = ZOBRIST[p * 90 + i];
      h0 ^= k[0];
      h1 ^= k[1];
    }
  }
  if (side === X.BLACK) {
    h0 ^= Z_SIDE[0];
    h1 ^= Z_SIDE[1];
  }
  return h0 + ':' + h1;
}

function mirrorIndex(i) {
  var r = (i / 9) | 0;
  return (9 - r) * 9 + (i % 9);
}

function evaluate(board, side) {
  var score = 0;
  for (var i = 0; i < 90; i++) {
    var p = board[i];
    if (!p) continue;
    var type = X.typeOf(p);
    var s = X.sideOf(p);
    var v = VALUE[type];
    if (type === X.P) {
      var r = (i / 9) | 0;
      v += s === X.RED ? Math.max(0, 4 - r) * 14 : Math.max(0, r - 5) * 14;
    }
    var tableIndex = s === X.RED ? i : mirrorIndex(i);
    v += PST[type][tableIndex];
    score += s === X.RED ? v : -v;
  }

  // 将帅安全：敌子逼近九宫时扣分
  var redGeneral = X.findGeneral(board, X.RED);
  var blackGeneral = X.findGeneral(board, X.BLACK);
  if (redGeneral >= 0) score -= dangerScore(board, redGeneral, X.BLACK);
  if (blackGeneral >= 0) score += dangerScore(board, blackGeneral, X.RED);

  return side === X.RED ? score : -score;
}

function dangerScore(board, target, bySide) {
  var tr = (target / 9) | 0;
  var tc = target % 9;
  var danger = 0;
  for (var i = 0; i < 90; i++) {
    var p = board[i];
    if (!p || X.sideOf(p) !== bySide) continue;
    var dr = Math.abs(((i / 9) | 0) - tr);
    var dc = Math.abs((i % 9) - tc);
    if (dr + dc > 3) continue;
    var t = X.typeOf(p);
    var w = t === X.R ? 26 : (t === X.C ? 20 : (t === X.N ? 16 : (t === X.P ? 12 : 4)));
    danger += w / (1 + dr + dc);
  }
  return danger;
}

var LEVELS = {
  easy: { maxDepth: 2, time: 180, random: 0.28, window: 90, qDepth: 12 },
  normal: { maxDepth: 5, time: 1200, random: 0.05, window: 25, qDepth: 12 },
  hard: { maxDepth: 6, time: 3000, random: 0, window: 0, qDepth: 12 },
  master: { maxDepth: 8, time: 6000, random: 0, window: 0, qDepth: 16 },
  grandmaster: { maxDepth: 10, time: 12000, random: 0, window: 0, qDepth: 20 }
};

function startSearch(board, side, levelName, gameCounts) {
  var level = LEVELS[levelName] || LEVELS.normal;
  var deadline = Date.now() + level.time;
  var maxTT = level.maxDepth >= 8 ? 600000 : 200000;
  var nodes = 0;
  var stopped = false;
  var tt = new Map();
  var repetition = new Map();
  var killers = new Array(80);
  var history = new Map();
  var rootKey = hashBoard(board, side);
  if (gameCounts) {
    // 完整载入真实对局里的局面出现次数（含只出现过 1 次的），
    // 这样搜索路径上的重复计数才准确，能提前识别"再走一遍就是三次重复"。
    for (var gk in gameCounts) {
      var gc = gameCounts[gk];
      if (gc > 0) repetition.set(gk, gc);
    }
  }
  repetition.set(rootKey, Math.max(repetition.get(rootKey) || 0, 1));

  function timeUp() {
    if ((nodes & 1023) === 0 && Date.now() >= deadline) stopped = true;
    return stopped;
  }

  function scoreMove(m, ttMove, killer, ply) {
    if (m === ttMove) return 10000000;
    var captured = board[m & 255];
    if (captured) {
      return 1000000 + VALUE[X.typeOf(captured)] * 16 - VALUE[X.typeOf(board[m >> 8])];
    }
    if (m === killer) return 900000;
    return history.get(m) || 0;
  }

  function orderMoves(moves, ttMove, ply) {
    for (var i = 0; i < moves.length; i++) {
      moves[i] = { m: moves[i], s: scoreMove(moves[i], ttMove, killers[ply], ply) };
    }
    moves.sort(function (a, b) { return b.s - a.s; });
    for (var j = 0; j < moves.length; j++) moves[j] = moves[j].m;
  }

  function quiesce(board, side, alpha, beta, ply) {
    nodes++;
    if (timeUp()) return 0;
    var stand = evaluate(board, side);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (ply >= level.qDepth) return stand;
    var caps = X.generateMoves(board, side, true);
    orderMoves(caps, 0, ply);
    for (var i = 0; i < caps.length; i++) {
      var m = caps[i];
      var victim = board[m & 255];
      if (stand + VALUE[X.typeOf(victim)] + 220 < alpha) continue;
      var captured = X.makeMove(board, m);
      var score = -quiesce(board, X.other(side), -beta, -alpha, ply + 1);
      X.unmakeMove(board, m, captured);
      if (stopped) return alpha;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return alpha;
  }

  function search(board, side, depth, alpha, beta, ply) {
    nodes++;
    if (timeUp()) return 0;
    var key = hashBoard(board, side);
    var count = (repetition.get(key) || 0) + 1;
    repetition.set(key, count);
    var result;
    if (count >= 3) {
      result = 0;
    } else if (X.findGeneral(board, side) < 0) {
      result = -MATE + ply;
    } else if (depth <= 0) {
      result = quiesce(board, side, alpha, beta, ply);
    } else {
      var entry = tt.get(key);
      var ttMove = 0;
      if (entry) {
        ttMove = entry.move;
        if (entry.depth >= depth) {
          if (entry.flag === 0) {
            result = entry.score;
            repetition.set(key, count - 1);
            return result;
          }
          if (entry.flag === 1 && entry.score >= beta) {
            result = entry.score;
            repetition.set(key, count - 1);
            return result;
          }
          if (entry.flag === 2 && entry.score <= alpha) {
            result = entry.score;
            repetition.set(key, count - 1);
            return result;
          }
        }
      }
      var moves = X.generateMoves(board, side, false);
      if (!moves.length) {
        result = -MATE + ply;
      } else {
        orderMoves(moves, ttMove, ply);
        var originalAlpha = alpha;
        var best = -INF;
        var bestMove = 0;
        for (var i = 0; i < moves.length; i++) {
          var m = moves[i];
          var captured = X.makeMove(board, m);
          var score = -search(board, X.other(side), depth - 1, -beta, -alpha, ply + 1);
          X.unmakeMove(board, m, captured);
          if (stopped) break;
          if (score > best) {
            best = score;
            bestMove = m;
          }
          if (score > alpha) alpha = score;
          if (alpha >= beta) {
            if (!captured) {
              killers[ply] = m;
              history.set(m, (history.get(m) || 0) + depth * depth);
            }
            break;
          }
        }
        if (!stopped) {
          if (tt.size > maxTT) tt.clear();
          tt.set(key, {
            depth: depth,
            score: best,
            flag: best <= originalAlpha ? 2 : (best >= beta ? 1 : 0),
            move: bestMove
          });
          result = best;
        } else {
          result = best > -INF ? best : 0;
        }
      }
    }
    repetition.set(key, count - 1);
    return result;
  }

  var rootMoves = X.generateMoves(board, side, false);
  if (!rootMoves.length) return { move: 0, score: -MATE, depth: 0, nodes: 0 };
  var scoreByMove = new Map();
  var bestMove = rootMoves[0];
  var bestScore = 0;
  var completedDepth = 0;

  for (var depth = 1; depth <= level.maxDepth; depth++) {
    var ordered = rootMoves.slice();
    ordered.sort(function (a, b) { return (scoreByMove.get(b) || 0) - (scoreByMove.get(a) || 0); });
    var alpha = -INF;
    var localBest = 0;
    var localScore = -INF;
    var newScores = new Map();
    for (var j = 0; j < ordered.length; j++) {
      var move = ordered[j];
      var captured = X.makeMove(board, move);
      var childKey = hashBoard(board, X.other(side));
      var childGameCount = ((gameCounts && gameCounts[childKey]) || 0) + 1;
      var score = -search(board, X.other(side), depth - 1, -INF, -alpha, 1);
      X.unmakeMove(board, move, captured);
      if (stopped) break;
      // 重复局面惩罚：第 3 次出现按规则是"不变作和/长将判负"，对 AI 几乎等于输；
      // 第 2 次出现说明在来回挪子，重罚以迫使它寻找有进展的着法。
      if (childGameCount >= 3) score = -MATE / 2;
      else if (childGameCount >= 2) score -= 240;
      newScores.set(move, score);
      if (score > localScore) {
        localScore = score;
        localBest = move;
      }
      if (score > alpha) alpha = score;
    }
    if (stopped) break;
    scoreByMove = newScores;
    bestMove = localBest;
    bestScore = localScore;
    completedDepth = depth;
    if (Math.abs(bestScore) > MATE - 100) break;
    if (Date.now() >= deadline) break;
  }

  repetition.set(rootKey, 0);
  if (level.random > 0 && bestMove) {
    var pairs = [];
    for (var p = 0; p < rootMoves.length; p++) {
      pairs.push({ m: rootMoves[p], s: scoreByMove.has(rootMoves[p]) ? scoreByMove.get(rootMoves[p]) : -INF });
    }
    pairs.sort(function (a, b) { return b.s - a.s; });
    var pool = [];
    for (var q = 0; q < pairs.length && q < 6; q++) {
      if (pairs[q].s >= bestScore - level.window) pool.push(pairs[q].m);
    }
    if (pool.length > 1 && Math.random() < level.random) {
      bestMove = pool[(Math.random() * pool.length) | 0];
    }
  }

  return { move: bestMove, score: bestScore, depth: completedDepth, nodes: nodes };
}

function chooseMove(board, side, level, gameCounts) {
  return startSearch(board, side, level, gameCounts);
}

module.exports = {
  chooseMove: chooseMove,
  hashBoard: hashBoard,
  evaluate: evaluate,
  LEVELS: LEVELS
};

});
__define("platform", function(module, exports, require){
'use strict';
// Web 版 platform：localStorage 存档 + 自定义 toast 钩子（game.js 注入）
function get(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function set(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 存储失败不影响对弈
  }
}

function toast(title) {
  if (typeof window !== 'undefined' && typeof window.__toast === 'function') {
    window.__toast(String(title));
  }
}

function vibrate() {
  // 桌面/移动 WebView 均不做震动反馈
}

module.exports = { get: get, set: set, toast: toast, vibrate: vibrate };

});
__define("sound", function(module, exports, require){
'use strict';
// Web 版音效：同样的 8kHz 8-bit WAV base64，通过 Web Audio API 解码播放
var MOVE_B64 = 'UklGRtwBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YbgBAADO3LWKbUstOoDI17CEaVE5Qn3A0q+CaVZDSHi1y6+Fa1xLS3GqxLCJcGJSTWqdvLCPd2lZT2OQsrCVf3JgUlyCp62aiHtpVld1maedj4V0XlZqi56clI6AaFhifZKWlZWMdV9fcoWNkpeVgmpha3mCipWaj3hpanJ3f42Zl4Z1cHBwdIGRl4+BenZwbXWFkZGKhYB3bW15houLi4qBdG5ye4GFio+LgHVzdnh7gouPiYB7eXZ0eIKKi4eEgXx1c3mBhYaHiIV9dnZ6fH6DiIqFf3t6eXh7gYeHhYOBfXh3en+Cg4WHhX96eXt8fICEh4WBf358eXp+goODhISBfXp7fX5/gYSFg4B+fnx7fH+Cg4KDg4B9e3x9fn+Bg4SCgH9+fXx8f4GCgoKCgX59fX5+foCCg4KBgH9+fH1+gICBgoKBgH5+fn19f4CBgYGBgX9+fn5+fn+BgoGBgIB/fn1+f3+AgIGBgYB/f35+fn+AgICBgYGAf39/fn5/gICAgIGBgH9/f39/f3+AgICAgIB/f39/f39/gICAgICAgH9/f39/f3+AgICAgICAf39/f39/f4CAgICAgA==';
var CAPTURE_B64 = 'UklGRpQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YXADAACju6HQ+9DM2cvLx8egnKNoflRYGBc8Hg8kKERibHF3j5Coys/U5eLf3L+1m5GTa2dOSDcwNDgoPC5GWGd1hYqYq7O7x8/Gw8O9tq6ih3luZFhNQEI1PjZCQlVbZnJ+kpmssrzBv8XCvLapppOHfnJiWk5LQkJBRUpNVmBqdIKQlqGssre7u7izraeck4h9c2hhWlBLS0hJTVRYYGt1fYeSmqKqrbKysq+rpZ+WjYN7cWlhW1VSUVBSVVpgZ293gImRmZ+lqausrKiloJqSi4N7cmxlYFtYVlZYW15jaXB4f4eOlJqfo6WmpqShnZiSi4V+d3FrZmFeXFxcXmFlam91fIKJjpSYnJ+goaCenJiTjomDfXdybWhlYmFgYWNlaW1yd3yCh4yRlZianJycm5iVkY2Ig355dXBsaWdlZWVmaGtucnZ7f4SIjZCTlpeYmJiWlJGOioaBfXl1cW5samloaWprbnF0eHyAhIeLjpGTlJWVlJORj4yJhYJ+end0cW9tbGxsbG5wcnV4e36ChIeJi42Oj4+Pj46MioiGg4F+e3l3dXNycXFxcXJ0dXd5fH+ChIeJi42Oj4+Pj46MioiGg4F+e3l3dXNycXFxcXJ0dXd5e36Ag4WHiYqMjI2NjYyLioiGhIKAfnt5eHZ1dHNzc3N0dXd4enx+gIKEhoeJioqLi4uKioiHhoSCgH59e3l4d3Z1dXV1dnZ3eXp8fX+BgoSFh4iIiYmJiYmIh4aEg4KAfn18enl4d3d2dnd3eHl6e3x9f4CCg4SFhoeHiIiIh4eGhYSDgoF/fn18e3p5eHh4eHh4eXp7fH1+f4CBg4SEhYaGh4eHhoaFhISDgoGAfn18fHt6enl5eXl5enp7fH1+f4CBgoKDhIWFhYWFhYWFhISDgoGAf39+fXx7e3t6enp6ent7fHx9fn9/gIGCgoOEhISEhYWEhISDg4KBgYB/fn59fHx8e3t7e3t7e3x8fX1+f3+AgYGCgoODg4SEhISDg4OCgoGBgH9/fn59fXx8fHx8fHx8fH19fX5+f4CAgYGCgoKDg4ODg4ODg4KCgYGBgIB/f35+fX19fHx8fHx8fH19fX5+f3+AgIGBgYKCgoKCgoKCgoKCgYGBgICAf39+fn59fX19fX19fX19fX5+fn9/f4CAgYGBgYKCgoKC';
var CHECK_B64 = 'UklGRiQFAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAFAACAwOPYpWArHTt5ut/YqWcxHzlzs9rYrW43ITdurNbXsXQ9JDZpptHXtHpDKDVkoMzVt39IKzRgmsfUuYVOLjRclMLSu4pUMjRZj73PvY5ZNjVVibjNvpNfOjZThLPKv5dkPjdQgK7Hv5ppQjhOe6nEwJ5uRzpNd6XBwKFzSzxLc6C+v6N3Tz5Kb5u6vqZ7U0BKbJe3vaiAWEJJaZOzvKmDXEVJZo6wu6uHYEhJY4qsuayKZEpJYYept62NaE1KX4Oltq2QbFBLXYChs66Tb1NMXHyesa6Vc1ZNW3mar66XdlpOWnaXra2ZeV1QWXSUqq2bfWBSWXGQqKycf2NTWG+NpauegmZVWG2KoqqfhWlXWGuHoKmgh2xZWGqFnaigim5bWWiCm6ehjHFdWWd/mKWhjXRgWmZ9laOhj3ZiW2V7k6KhkXlkXGR5kKChkntmXWR3jp6gk31pXmN1jJyglIBrYGN0iZuflYFtYWNyh5meloNvYmNxhZeel4VxZGNwg5Wdl4dzZWRvgZOcl4h1Z2RugJGbmIp3aGVtfo+ZmIt5amVsfI6YmIx7bGZse4yXl418bWdreYqWl45+b2hreIiUl49/cGhrd4eTlo+BcmlrdoWSlpCCdGprdYSQlZCEdWxrdIKPlZGFd21rc4GOlJGGeG5sc4CMk5GHeW9scn6LkpGIe3Bscn2KkZGJfHFtcXyIkJGJfXJucXuHkJGKfnRucXqGj5CKf3VvcXmFjpCLgY6OgnRvd4aPjH9zcHqIj4p9cnF8io+IenFzf4uOhXhxdYKMjYN2cXeEjYyAdXJ5ho2KfnNzfIiNiHxzdH6JjYZ6cnaBi4yDeHJ3g4uLgXZzeYWMiX91dHuGjIh9dHV+iIyGe3R2gImLhHl0eIKKioJ4dHmDiomAd3V7hYqHfnZ2fYaKhnx1d3+IioR7dXiBiImCeXV5gomIgHh2e4SJh393dn2FiYV9d3d+homEfHZ4gIeIgnp2eoKIh4F5d3uDiIZ/eHd8hIiFfnh4foWIhH13eX+GiIN7d3qBh4eBend7goeGgHl4fIOHhX95eH6Eh4R9eHl/hYeDfHh6gIaGgnt4e4GGhoB6eXyChoV/enl9g4aEfnl6f4SGg315eoCFhoJ8eXuBhYWBe3l8goWEgHt6fYOGhH96en6DhYN+ent/hIWCfXp7gISFgXx6fIGFhIB7en2ChYN/e3p+g4WDfnt7f4OFgn16fICEhIF9enyBhISAfHt9gYSDf3x7foKEg397e3+DhIJ+e3x/g4SBfXt8gIOEgH17fYGEg4B8e36ChIN/fHx+goSCfnx8f4OEgX58fYCDg4F9fH2Bg4OAfXx+gYOCf3x8foKDgn98fH+Cg4F+fH2AgoOBfnx9gIODgH18foGDgn99fH6Bg4J/fX1/goOBfnx9f4KDgX58fYCCgoB+fH6AgoKAfX1+gYKCf319f4GCgX99fX+CgoF+fX2AgoKAfn1+gIKCgH59foGCgn99fX+BgoF/fX1/gYKBf319gIKCgH59foCCgoB+fX6AgoGAfn1/gYKBf319f4GCgX99fn+BgoB+fX6AgYKAfn1+gIKBgH59f4CCgX9+fn+BgoF/fn5/gYGAf35+gIGBgH5+foCBgYB+fn+AgYF/fn5/gIGBf35+f4GBgH9+fn+BgYB/fn6AgYGAfn5/gIGBgH5+f4CBgX9+fn+BgYB/fg==';

var B64 = { move: MOVE_B64, capture: CAPTURE_B64, check: CHECK_B64 };

var audioCtx = null;
var buffers = {};
var enabled = true;
var failed = false;

function ensureCtx() {
  if (failed) return null;
  if (!audioCtx) {
    var AC = typeof AudioContext !== 'undefined' ? AudioContext :
      (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    if (!AC) { failed = true; return null; }
    try { audioCtx = new AC(); } catch (e) { failed = true; return null; }
  }
  if (audioCtx.state === 'suspended') {
    try { audioCtx.resume(); } catch (e) {}
  }
  return audioCtx;
}

function b64ToArrayBuffer(b64) {
  var bin = atob(b64);
  var len = bin.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function ensure(name) {
  if (buffers[name]) return buffers[name];
  if (failed) return null;
  var ac = ensureCtx();
  if (!ac) return null;
  try {
    ac.decodeAudioData(b64ToArrayBuffer(B64[name]), function (buf) {
      buffers[name] = buf;
    }, function () {
      failed = true;
    });
  } catch (e) {
    failed = true;
    return null;
  }
  return buffers[name] || null;
}

function play(name) {
  if (!enabled) return;
  var ac = ensureCtx();
  if (!ac) return;
  var buf = ensure(name);
  if (!buf) return;
  try {
    var src = ac.createBufferSource();
    var gain = ac.createGain();
    gain.gain.value = 0.6;
    src.buffer = buf;
    src.connect(gain);
    gain.connect(ac.destination);
    src.start(0);
  } catch (e) {
    // 播放失败静默忽略
  }
}

// 预解码，避免第一声延迟
function warmup() {
  ensure('move'); ensure('capture'); ensure('check');
}

module.exports = {
  play: play,
  move: function () { play('move'); },
  capture: function () { play('capture'); },
  check: function () { play('check'); },
  setEnabled: function (value) { enabled = !!value; },
  isEnabled: function () { return enabled; },
  warmup: warmup
};

});
})();
