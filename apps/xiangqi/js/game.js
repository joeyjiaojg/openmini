'use strict';
// 楚汉象棋 · HTML5 版（Canvas 渲染）
// 逻辑与小程序版 pages/index/index.js 保持一致：
// 棋子对齐网格线、上一步高亮、三次重复判和、长将判负、AI 重复局面感知

var X = window.XQ.require('xiangqi');
var AI = window.XQ.require('ai');
var platform = window.XQ.require('platform');
var Sound = window.XQ.require('sound');

var CELL = 76;          // 逻辑格距（棋子落在网格线交叉点上）
var PAD = 36;           // 逻辑边距
var BOARD_W = PAD * 2 + CELL * 8;   // 680
var BOARD_H = PAD * 2 + CELL * 9;   // 756
var SAVE_KEY = 'xiangqi.save.v1';
var SETTINGS_KEY = 'xiangqi.settings.v1';
var LEVEL_LABELS = {
  easy: '入门', normal: '普通', hard: '大师', master: '宗师', grandmaster: '棋圣'
};
var LEVEL_DESCS = {
  easy: '轻松对弈，适合新手',
  normal: '五层搜索，推荐日常使用',
  hard: '六层深度计算，全力争胜',
  master: '八层搜索，6 秒深度推演',
  grandmaster: '十层极限计算，慢但最强'
};

// ---------- DOM ----------
var canvas = document.getElementById('board');
var ctx = canvas.getContext('2d');
var elStatus = document.getElementById('status');
var elHistory = document.getElementById('history');
var elCapturedRed = document.getElementById('captured-red');
var elCapturedBlack = document.getElementById('captured-black');
var elMoveCount = document.getElementById('move-count');
var elToast = document.getElementById('toast');
var elStartOverlay = document.getElementById('start-overlay');
var elResultOverlay = document.getElementById('result-overlay');
var elResultTitle = document.getElementById('result-title');
var elResultReason = document.getElementById('result-reason');
var elBtnContinue = document.getElementById('btn-continue');
var elLevelModal = document.getElementById('level-modal');

// ---------- 游戏状态 ----------
var board, side, playerSide, level, moveHistory, capturedRed, capturedBlack;
var snapshots, lastMove, selected, legalTargets, checkGeneral, hintFrom, hintTo;
var thinking, gameOver, resultText, resultReason;
var posCounts, checkStreak, soundEnabled, moveCount, hasSave, toastTimer;
var mode = 'human';          // 'human' 人机对战 | 'ai' 机器对战（观战）
var noCapturePlies = 0;      // 连续无吃子步数（120 步 = 60 回合，判和）
var AI_MOVE_DELAY = 1100;    // 观战模式每步停留时间，便于观察
var NO_CAPTURE_LIMIT = 120;
var REPEAT_CHECK_WIN = 2;    // 连续将军达到该次数且三次重复 → 长将判负

function validBoard(b) {
  if (!b || b.length !== 90) return false;
  for (var i = 0; i < 90; i++) {
    if (typeof b[i] !== 'number' || b[i] < 0 || b[i] > 15) return false;
  }
  return true;
}

function copyCounts(src) {
  var out = {};
  for (var k in src) out[k] = src[k];
  return out;
}

// ---------- Toast ----------
function showToast(title) {
  elToast.textContent = title;
  elToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { elToast.classList.remove('show'); }, 1800);
}
window.__toast = showToast;

// ---------- 初始化 ----------
function loadState() {
  board = X.initialBoard();
  side = X.RED;
  playerSide = X.RED;
  level = 'normal';
  moveHistory = [];
  capturedRed = [];
  capturedBlack = [];
  snapshots = [];
  lastMove = null;
  selected = -1;
  legalTargets = [];
  checkGeneral = -1;
  hintFrom = -1;
  hintTo = -1;
  thinking = false;
  gameOver = false;
  resultText = '';
  resultReason = '';
  moveCount = 0;
  posCounts = {};
  checkStreak = {};
  noCapturePlies = 0;
  mode = 'human';
  soundEnabled = true;

  var settings = platform.get(SETTINGS_KEY, null);
  if (settings) {
    if (AI.LEVELS[settings.level]) level = settings.level;
    if (settings.playerSide === X.RED || settings.playerSide === X.BLACK) playerSide = settings.playerSide;
    if (typeof settings.soundOn === 'boolean') soundEnabled = settings.soundOn;
    if (settings.mode === 'ai') mode = 'ai';
  }
  Sound.setEnabled(soundEnabled !== false);

  hasSave = false;
  var save = platform.get(SAVE_KEY, null);
  if (save && validBoard(save.board) &&
      (save.side === X.RED || save.side === X.BLACK)) {
    var savedMode = save.mode === 'ai' ? 'ai' : 'human';
    if (savedMode === 'ai' || save.playerSide === X.RED || save.playerSide === X.BLACK) {
      hasSave = true;
    }
  }
}

function resumeGame() {
  var save = platform.get(SAVE_KEY, null);
  if (!save || !validBoard(save.board)) return false;
  board = save.board.slice();
  side = save.side;
  mode = save.mode === 'ai' ? 'ai' : 'human';
  playerSide = mode === 'ai' ? -1 : save.playerSide;
  moveHistory = Array.isArray(save.history) ? save.history : [];
  capturedRed = Array.isArray(save.capturedRed) ? save.capturedRed : [];
  capturedBlack = Array.isArray(save.capturedBlack) ? save.capturedBlack : [];
  lastMove = save.lastMove || null;
  moveCount = typeof save.moveCount === 'number' ? save.moveCount : moveHistory.length;
  noCapturePlies = typeof save.noCapturePlies === 'number' ? save.noCapturePlies : 0;
  if (AI.LEVELS[save.level]) level = save.level;
  posCounts = save.posCounts && typeof save.posCounts === 'object' && !(save.posCounts instanceof Array) ? save.posCounts : {};
  checkStreak = save.checkStreak && typeof save.checkStreak === 'object' && !(save.checkStreak instanceof Array) ? save.checkStreak : {};
  var curKey = String(AI.hashBoard(board, side));
  if (!posCounts[curKey]) posCounts[curKey] = 1;
  selected = -1; legalTargets = [];
  hintFrom = -1; hintTo = -1;
  gameOver = false; resultText = ''; resultReason = '';
  var savedStatus = X.gameStatus(board, side);
  if (savedStatus.over) finishByStatus(savedStatus);
  updateUI();
  if (!gameOver && (mode === 'ai' || side !== playerSide)) scheduleAI();
  return true;
}

function startGame(newMode, newPlayerSide, newLevel) {
  board = X.initialBoard();
  side = X.RED;
  mode = newMode === 'ai' ? 'ai' : 'human';
  playerSide = mode === 'ai' ? -1 : newPlayerSide;
  level = AI.LEVELS[newLevel] ? newLevel : 'normal';
  moveHistory = [];
  capturedRed = [];
  capturedBlack = [];
  snapshots = [];
  lastMove = null;
  selected = -1;
  legalTargets = [];
  checkGeneral = -1;
  hintFrom = -1;
  hintTo = -1;
  moveCount = 0;
  noCapturePlies = 0;
  thinking = false;
  gameOver = false;
  resultText = '';
  resultReason = '';
  posCounts = {};
  checkStreak = {};
  posCounts[String(AI.hashBoard(board, side))] = 1;
  saveSettings();
  saveGame();
  elStartOverlay.style.display = 'none';
  elResultOverlay.style.display = 'none';
  updateUI();
  if (mode === 'ai' || side !== playerSide) scheduleAI();
}

function saveGame() {
  platform.set(SAVE_KEY, {
    board: board,
    side: side,
    playerSide: playerSide,
    mode: mode,
    level: level,
    history: moveHistory,
    capturedRed: capturedRed,
    capturedBlack: capturedBlack,
    lastMove: lastMove,
    moveCount: moveCount,
    noCapturePlies: noCapturePlies,
    posCounts: posCounts,
    checkStreak: checkStreak
  });
}

function saveSettings() {
  platform.set(SETTINGS_KEY, {
    level: level,
    playerSide: playerSide,
    mode: mode,
    soundOn: soundEnabled !== false
  });
}

// ---------- 结束 ----------
function sideName(s) {
  return s === X.RED ? '红方' : '黑方';
}

function finishByStatus(status) {
  gameOver = true;
  if (mode === 'ai') {
    resultText = status.winner === X.RED ? '红方胜' : (status.winner === X.BLACK ? '黑方胜' : '和棋');
  } else {
    resultText = status.winner === playerSide ? '你赢了' : '你输了';
  }
  resultReason = status.reason === 'checkmate' ? '将死' :
    (status.reason === 'stalemate' ? '困毙，无棋可走' : '将帅被吃');
  showResult();
}

function finishByRepetition() {
  gameOver = true;
  var checker = (checkStreak[X.RED] || 0) >= REPEAT_CHECK_WIN ? X.RED :
    ((checkStreak[X.BLACK] || 0) >= REPEAT_CHECK_WIN ? X.BLACK : -1);
  if (checker >= 0) {
    resultText = mode === 'ai' ? (checker === X.RED ? '黑方胜' : '红方胜')
      : (checker === playerSide ? '你输了' : '你赢了');
    resultReason = sideName(checker) + '长将判负（反复将军不改走法）';
  } else {
    resultText = '和棋';
    resultReason = '同一局面出现三次，不变作和';
  }
  showResult();
}

function finishByNoCapture() {
  gameOver = true;
  resultText = '和棋';
  resultReason = '连续 60 回合无吃子，按规则判和';
  showResult();
}

function showResult() {
  elResultTitle.textContent = resultText;
  elResultReason.textContent = resultReason;
  elResultOverlay.style.display = 'flex';
}

// ---------- 走子 ----------
function doMove(move) {
  var from = move >> 8;
  var to = move & 255;
  var mover = side;
  var notation = X.moveToChinese(board, move, mover);
  snapshots.push({
    board: board.slice(),
    side: mover,
    history: moveHistory.slice(),
    capturedRed: capturedRed.slice(),
    capturedBlack: capturedBlack.slice(),
    moveCount: moveCount,
    lastMove: lastMove,
    posCounts: copyCounts(posCounts),
    checkStreak: copyCounts(checkStreak),
    noCapturePlies: noCapturePlies
  });

  var victim = X.makeMove(board, move);
  if (victim) {
    if (mover === X.RED) capturedRed.push(victim);
    else capturedBlack.push(victim);
    noCapturePlies = 0;
  } else {
    noCapturePlies++;
  }
  Sound.play(victim ? 'capture' : 'move');
  moveHistory.push({ text: notation, red: mover === X.RED, seq: moveCount + 1 });
  moveCount++;
  lastMove = { from: from, to: to };
  selected = -1;
  legalTargets = [];
  hintFrom = -1;
  hintTo = -1;
  side = X.other(mover);

  var status = X.gameStatus(board, side);
  var gaveCheck = X.isInCheck(board, side);
  checkGeneral = gaveCheck ? X.findGeneral(board, side) : -1;
  if (gaveCheck) Sound.play('check');
  checkStreak[mover] = gaveCheck ? (checkStreak[mover] || 0) + 1 : 0;
  var posKey = String(AI.hashBoard(board, side));
  posCounts[posKey] = (posCounts[posKey] || 0) + 1;
  if (!status.over && posCounts[posKey] >= 3) {
    finishByRepetition();
  } else if (!status.over && noCapturePlies >= NO_CAPTURE_LIMIT) {
    finishByNoCapture();
  } else if (status.over) {
    finishByStatus(status);
  }
  saveGame();
  updateUI();
  if (!gameOver && (mode === 'ai' || side !== playerSide)) scheduleAI();
}

function scheduleAI() {
  thinking = true;
  updateUI();
  // 观战模式每步多停留一会儿，让人看清走法；人机模式保持轻快
  var delay = mode === 'ai' ? AI_MOVE_DELAY : 120;
  setTimeout(function () {
    if (gameOver) { thinking = false; return; }
    var result = AI.chooseMove(board, side, level, posCounts);
    thinking = false;
    if (!result.move) {
      finishByStatus(X.gameStatus(board, side));
      updateUI();
      return;
    }
    doMove(result.move);
  }, delay);
}

// ---------- 交互 ----------
function onCanvasTap(event) {
  Sound.warmup();
  if (thinking || gameOver) return;
  if (mode === 'ai') {
    showToast('观战中，双方均由 AI 执子');
    return;
  }
  if (side !== playerSide) return;

  var rect = canvas.getBoundingClientRect();
  var scale = BOARD_W / rect.width;
  var x = (event.clientX - rect.left) * scale;
  var y = (event.clientY - rect.top) * scale;
  var col = Math.round((x - PAD) / CELL);
  var row = Math.round((y - PAD) / CELL);
  if (col < 0 || col > 8 || row < 0 || row > 9) return;
  var index = row * 9 + col;
  // 点击位置离交叉点太远则忽略（超过 0.42 格视为空白处）
  var dx = x - (PAD + col * CELL);
  var dy = y - (PAD + row * CELL);
  if (dx * dx + dy * dy > Math.pow(CELL * 0.42, 2)) return;

  if (selected >= 0 && legalTargets.indexOf(index) >= 0) {
    doMove(selected * 256 + index);
    return;
  }
  var piece = board[index];
  if (piece && X.sideOf(piece) === side) {
    selected = index;
    legalTargets = X.generateMoves(board, side, false)
      .filter(function (m) { return (m >> 8) === index; })
      .map(function (m) { return m & 255; });
  } else {
    selected = -1;
    legalTargets = [];
  }
  updateUI();
}

function undo() {
  if (mode === 'ai') {
    showToast('观战模式不支持悔棋');
    return;
  }
  if (thinking || !moveHistory.length) {
    showToast('当前不能悔棋');
    return;
  }
  var target = null;
  while (snapshots.length) {
    var snapshot = snapshots.pop();
    if (snapshot.side === playerSide) {
      target = snapshot;
      break;
    }
  }
  if (!target) {
    showToast('没有可悔的棋');
    return;
  }
  board = target.board.slice();
  side = target.side;
  moveHistory = target.history.slice();
  capturedRed = target.capturedRed.slice();
  capturedBlack = target.capturedBlack.slice();
  moveCount = target.moveCount;
  lastMove = target.lastMove;
  posCounts = target.posCounts ? copyCounts(target.posCounts) : {};
  checkStreak = target.checkStreak ? copyCounts(target.checkStreak) : {};
  noCapturePlies = typeof target.noCapturePlies === 'number' ? target.noCapturePlies : 0;
  selected = -1;
  legalTargets = [];
  checkGeneral = X.isInCheck(board, side) ? X.findGeneral(board, side) : -1;
  gameOver = false;
  resultText = '';
  resultReason = '';
  hintFrom = -1;
  hintTo = -1;
  elResultOverlay.style.display = 'none';
  saveGame();
  updateUI();
  showToast('已悔棋');
}

function hint() {
  if (mode === 'ai') {
    showToast('观战中，不需要提示');
    return;
  }
  if (thinking || gameOver || side !== playerSide) {
    showToast('请等轮到你走棋时再使用提示');
    return;
  }
  showToast('正在计算建议走法…');
  setTimeout(function () {
    var result = AI.chooseMove(board, side, 'hard');
    if (!result.move) {
      showToast('当前没有可走的棋');
      return;
    }
    hintFrom = result.move >> 8;
    hintTo = result.move & 255;
    var text = X.moveToChinese(board, result.move, side);
    showToast('建议：' + text);
    updateUI();
  }, 120);
}

function toggleSound() {
  soundEnabled = !(soundEnabled !== false);
  Sound.setEnabled(soundEnabled);
  saveSettings();
  if (soundEnabled) { Sound.warmup(); Sound.move(); }
  renderSoundBtn();
  showToast(soundEnabled ? '音效已开启' : '音效已关闭');
}

// 兼容旧版 WebView：NodeList.forEach 不可用，统一用 for 循环遍历
function each(sel, fn) {
  var nodes = document.querySelectorAll(sel);
  for (var i = 0; i < nodes.length; i++) fn(nodes[i], i);
}

function cycleLevel() {
  // 直接打开难度选择弹窗
  openLevelModal();
}

function setLevel(lv) {
  if (!AI.LEVELS[lv]) return;
  level = lv;
  saveSettings();
  each('#level-modal .level-item', function (node) {
    node.classList.toggle('active', node.dataset.level === lv);
  });
  renderLevelBtn();
}

function renderLevelBtn() {
  document.getElementById('btn-level').textContent = '难度·' + LEVEL_LABELS[level];
}

function renderSoundBtn() {
  document.getElementById('btn-sound').textContent = soundEnabled !== false ? '🔊 音效' : '🔇 静音';
}

function openLevelModal() {
  elLevelModal.style.display = 'flex';
}
function closeLevelModal() {
  elLevelModal.style.display = 'none';
}

// ---------- UI 更新 ----------
function updateUI() {
  var statusText = '';
  var tone = 'normal';
  if (gameOver) {
    statusText = resultText + ' · ' + resultReason;
    tone = 'over';
  } else if (thinking) {
    if (mode === 'ai') statusText = sideName(side) + '思考中…';
    else statusText = '对手思考中…';
    tone = 'thinking';
  } else if (X.isInCheck(board, side)) {
    statusText = (side === X.RED ? '红方' : '黑方') + '被将军！请应将';
    tone = 'check';
  } else if (mode === 'human' && side === playerSide) {
    statusText = '轮到你走棋';
    tone = 'ready';
  } else {
    statusText = sideName(side) + '走棋';
  }
  elStatus.textContent = statusText;
  elStatus.className = 'status ' + tone;

  elMoveCount.textContent = '第 ' + (moveCount + (gameOver ? 0 : 1)) + ' 手';

  elCapturedRed.textContent = capturedRed.map(function (p) {
    return X.PIECE_NAME[X.typeOf(p)][X.sideOf(p)];
  }).join(' ') || '—';
  elCapturedBlack.textContent = capturedBlack.map(function (p) {
    return X.PIECE_NAME[X.typeOf(p)][X.sideOf(p)];
  }).join(' ') || '—';

  var recent = moveHistory.slice(-12).reverse();
  var html = '';
  for (var i = 0; i < recent.length; i++) {
    html += '<span class="mv ' + (recent[i].red ? 'red' : 'black') + '">' +
      (recent[i].seq) + '. ' + recent[i].text + '</span>';
  }
  elHistory.innerHTML = html || '<span class="mv dim">对局开始</span>';

  draw();
}

// ---------- Canvas 绘制 ----------
function dprCanvas() {
  var dpr = window.devicePixelRatio || 1;
  var cssW = canvas.clientWidth || BOARD_W;
  var scale = cssW / BOARD_W;
  canvas.width = Math.round(BOARD_W * scale * dpr);
  canvas.height = Math.round(BOARD_H * scale * dpr);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
}

function linePos(col, row) {
  return { x: PAD + col * CELL, y: PAD + row * CELL };
}

function draw() {
  dprCanvas();
  var W = BOARD_W, H = BOARD_H;

  // 棋盘底色
  ctx.fillStyle = '#f3e2c1';
  ctx.fillRect(0, 0, W, H);
  var grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,244,214,0.5)');
  grad.addColorStop(1, 'rgba(196,156,94,0.25)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  var lineColor = '#8a5a2b';

  // 横线
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.4;
  for (var r = 0; r < 10; r++) {
    var y = PAD + r * CELL;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(PAD + 8 * CELL, y);
    ctx.stroke();
  }
  // 竖线（中间断开为楚河汉界）
  for (var c = 0; c < 9; c++) {
    var x = PAD + c * CELL;
    if (c === 0 || c === 8) {
      ctx.beginPath();
      ctx.moveTo(x, PAD);
      ctx.lineTo(x, PAD + 9 * CELL);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(x, PAD);
      ctx.lineTo(x, PAD + 4 * CELL);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, PAD + 5 * CELL);
      ctx.lineTo(x, PAD + 9 * CELL);
      ctx.stroke();
    }
  }
  // 外框加粗
  ctx.lineWidth = 3.4;
  ctx.strokeRect(PAD - 6, PAD - 6, 8 * CELL + 12, 9 * CELL + 12);
  ctx.lineWidth = 1.2;
  ctx.strokeRect(PAD - 12, PAD - 12, 8 * CELL + 24, 9 * CELL + 24);

  // 九宫斜线
  var palaces = [[0, 2], [7, 9]];
  ctx.lineWidth = 1.2;
  for (var pi = 0; pi < palaces.length; pi++) {
    var topRow = palaces[pi][0], botRow = palaces[pi][1];
    var tl = linePos(3, topRow), br = linePos(5, botRow);
    var tr = linePos(5, topRow), bl = linePos(3, botRow);
    ctx.beginPath(); ctx.moveTo(tl.x, tl.y); ctx.lineTo(br.x, br.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y); ctx.stroke();
  }

  // 楚河汉界
  ctx.fillStyle = 'rgba(110,70,30,0.75)';
  ctx.font = 'bold 30px KaiTi, STKaiti, "Kaiti SC", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  var riverY = PAD + 4.5 * CELL;
  ctx.fillText('楚  河', PAD + 2 * CELL, riverY);
  ctx.fillText('汉  界', PAD + 6 * CELL, riverY);

  // 炮位/兵位标记
  ctx.lineWidth = 1.1;
  var marks = [[1, 2], [7, 2], [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
               [0, 6], [2, 6], [4, 6], [6, 6], [8, 6], [1, 7], [7, 7]];
  for (var mi = 0; mi < marks.length; mi++) drawMark(marks[mi][0], marks[mi][1]);

  // 上一步：出发点琥珀方框
  if (lastMove) {
    var f = linePos(lastMove.from % 9, (lastMove.from / 9) | 0);
    ctx.save();
    ctx.strokeStyle = '#e8a23a';
    ctx.lineWidth = 3;
    roundRect(f.x - 30, f.y - 30, 60, 60, 8);
    ctx.stroke();
    ctx.restore();
  }

  // 棋子
  for (var i = 0; i < 90; i++) {
    var p = board[i];
    if (!p) continue;
    var col2 = i % 9, row2 = (i / 9) | 0;
    var pos = linePos(col2, row2);
    var isSel = i === selected;
    var isLastTo = lastMove && i === lastMove.to;
    var isCheck = i === checkGeneral;
    var isHint = i === hintFrom || i === hintTo;
    drawPiece(pos.x, pos.y, p, isSel, isLastTo, isCheck, isHint);
  }

  // 合法落点
  for (var t = 0; t < legalTargets.length; t++) {
    var ti = legalTargets[t];
    var tpos = linePos(ti % 9, (ti / 9) | 0);
    if (board[ti]) {
      ctx.save();
      ctx.strokeStyle = '#2e9e5b';
      ctx.lineWidth = 2.6;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(tpos.x, tpos.y, 40, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = '#2e9e5b';
      ctx.beginPath();
      ctx.arc(tpos.x, tpos.y, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawMark(col, row) {
  var pos = linePos(col, row);
  var g = 5, l = 13; // 缝隙与长度
  var dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (var d = 0; d < dirs.length; d++) {
    var sx = dirs[d][0], sy = dirs[d][1];
    var cx = pos.x + sx * g, cy = pos.y + sy * g;
    // 边界列只画朝内的一半
    if ((col === 0 && sx < 0) || (col === 8 && sx > 0)) continue;
    ctx.strokeStyle = '#8a5a2b';
    ctx.beginPath();
    ctx.moveTo(cx + sx * l, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * l);
    ctx.stroke();
  }
}

function drawPiece(x, y, piece, isSel, isLastTo, isCheck, isHint) {
  var red = X.sideOf(piece) === X.RED;
  var text = X.PIECE_NAME[X.typeOf(piece)][X.sideOf(piece)];
  var R = 33;

  ctx.save();

  // 光圈
  if (isCheck) {
    ctx.shadowColor = 'rgba(226,58,44,0.95)';
    ctx.shadowBlur = 22;
  } else if (isSel) {
    ctx.shadowColor = 'rgba(240,180,50,0.95)';
    ctx.shadowBlur = 18;
  } else if (isHint) {
    ctx.shadowColor = 'rgba(120,90,240,0.95)';
    ctx.shadowBlur = 18;
  } else if (isLastTo) {
    ctx.shadowColor = 'rgba(240,180,50,0.85)';
    ctx.shadowBlur = 14;
  }

  // 底盘阴影
  if (isSel) {
    ctx.beginPath();
    ctx.ellipse(x, y + 5, R, R, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(60,40,10,0.18)';
    ctx.fill();
  }

  // 棋子主体
  ctx.beginPath();
  ctx.arc(x, y - (isSel ? 3 : 0), R, 0, Math.PI * 2);
  var pg = ctx.createRadialGradient(x - 10, y - 14, 4, x, y, R + 4);
  pg.addColorStop(0, '#fffaf0');
  pg.addColorStop(1, red ? '#fbe9d0' : '#efe4c8');
  ctx.fillStyle = pg;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  ctx.lineWidth = 2.6;
  ctx.strokeStyle = red ? '#b33a2b' : '#3a3a3a';
  ctx.stroke();

  // 内圈
  ctx.beginPath();
  ctx.arc(x, y - (isSel ? 3 : 0), R - 6, 0, Math.PI * 2);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = red ? 'rgba(179,58,43,0.55)' : 'rgba(58,58,58,0.45)';
  ctx.stroke();

  // 字
  ctx.fillStyle = red ? '#c23a2b' : '#1f1f1f';
  ctx.font = 'bold 36px KaiTi, STKaiti, "Kaiti SC", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - (isSel ? 3 : 0) + 1);

  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 事件绑定 ----------
canvas.addEventListener('click', onCanvasTap);
document.getElementById('btn-new').addEventListener('click', function () {
  // 有进行中的存档时才显示"继续上次对局"
  var save = platform.get(SAVE_KEY, null);
  elBtnContinue.style.display = (save && validBoard(save.board)) ? '' : 'none';
  elStartOverlay.style.display = 'flex';
});
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-hint').addEventListener('click', hint);
document.getElementById('btn-level').addEventListener('click', cycleLevel);
document.getElementById('btn-sound').addEventListener('click', toggleSound);

var startSide = X.RED;
var startLevel = 'normal';
var startMode = 'human';
each('#mode-picker button', function (btn) {
  btn.addEventListener('click', function () {
    startMode = btn.dataset.mode === 'ai' ? 'ai' : 'human';
    each('#mode-picker button', function (b) {
      b.classList.toggle('active', b === btn);
    });
    // 观战模式没有"你执哪一方"，隐藏执子选择
    document.getElementById('side-picker').style.display =
      startMode === 'ai' ? 'none' : 'flex';
    document.getElementById('mode-tip').style.display =
      startMode === 'ai' ? '' : 'none';
  });
});
each('#side-picker button', function (btn) {
  btn.addEventListener('click', function () {
    startSide = Number(btn.dataset.side);
    each('#side-picker button', function (b) {
      b.classList.toggle('active', b === btn);
    });
  });
});
each('#level-picker button', function (btn) {
  btn.addEventListener('click', function () {
    startLevel = btn.dataset.level;
    each('#level-picker button', function (b) {
      b.classList.toggle('active', b === btn);
    });
  });
});
document.getElementById('btn-begin').addEventListener('click', function () {
  Sound.warmup();
  startGame(startMode, startSide, startLevel);
});
elBtnContinue.addEventListener('click', function () {
  if (!resumeGame()) showToast('没有可继续的对局');
});
document.getElementById('btn-restart').addEventListener('click', function () {
  elResultOverlay.style.display = 'none';
  elStartOverlay.style.display = 'flex';
});
document.getElementById('btn-review').addEventListener('click', function () {
  elResultOverlay.style.display = 'none';
  showToast('可查看棋谱与被吃棋子复盘');
});
each('#level-modal .level-item', function (item) {
  item.addEventListener('click', function () {
    setLevel(item.dataset.level);
    closeLevelModal();
    showToast('难度已切换为' + LEVEL_LABELS[level]);
  });
});
document.getElementById('level-close').addEventListener('click', closeLevelModal);

window.addEventListener('resize', function () { draw(); });

// ---------- 启动 ----------
loadState();
setLevel(level);
renderSoundBtn();
if (hasSave) {
  elBtnContinue.style.display = '';
} else {
  elBtnContinue.style.display = 'none';
}
elStartOverlay.style.display = 'flex';
updateUI();
