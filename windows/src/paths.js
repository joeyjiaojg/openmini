/* OpenMini 桌面版数据目录（Windows / Linux 统一）
 *
 * 优先级：
 *   1. 环境变量 OPENMINI_DATA   —— 自定义位置（测试 / 高级用户）
 *   2. 开发模式（electron .）   —— windows/data-dev/，避免污染真实目录
 *   3. 程序目录存在 portable.txt —— 便携模式：数据留在程序目录 data/（U 盘拷走）
 *   4. 默认                     —— 用户目录 ~/.openmini
 *      Windows: C:\Users\<你>\.openmini
 *      Linux:   /home/<你>/.openmini
 *
 * 旧版 v1.0.x 把数据放在程序目录 data/，升级后首次启动会自动迁移到 ~/.openmini。
 * 本模块不依赖 Electron，可直接用 Node 做单元测试（含 Linux 路径语义）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

function fsExists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

function resolve(opts) {
  opts = opts || {};
  const P = opts.pathModule || path;
  const home = opts.home || os.homedir();
  const execPath = opts.execPath || process.execPath;
  const env = opts.env || process.env;
  const exists = opts.exists || fsExists;
  const isDev = !!opts.isDev;
  const devRoot = opts.devRoot || '';
  const platform = opts.platform || process.platform;

  const exeDir = P.dirname(execPath);
  const legacyDir = P.join(exeDir, 'data');
  const homeDir = P.join(home, '.openmini');
  const common = { legacyDir: legacyDir, exeDir: exeDir, platform: platform };

  const custom = env.OPENMINI_DATA && String(env.OPENMINI_DATA).trim();
  if (custom) return Object.assign({ dir: P.resolve(String(custom).trim()), mode: 'env' }, common);
  if (isDev) return Object.assign({ dir: P.join(devRoot, 'data-dev'), mode: 'dev' }, common);
  if (exists(P.join(exeDir, 'portable.txt'))) return Object.assign({ dir: legacyDir, mode: 'portable' }, common);
  return Object.assign({ dir: homeDir, mode: 'home' }, common);
}

/* 迁移旧版 data/ → 新目录。只在默认 home 模式且目标尚不存在时执行。
 * rename 跨磁盘分区会失败（Windows EXDEV），自动降级为「复制后删除」。
 * 返回 { moved, via, reason }，任何失败都不阻塞启动。
 */
function migrate(info, opts) {
  opts = opts || {};
  const P = opts.pathModule || path;
  const exists = opts.exists || fsExists;
  const rename = opts.rename || function (a, b) { fs.renameSync(a, b); };
  const mkdir = opts.mkdir || function (d) { fs.mkdirSync(d, { recursive: true }); };
  const copy = opts.copy || function (a, b) { fs.cpSync(a, b, { recursive: true, force: true }); };
  const remove = opts.remove || function (d) { fs.rmSync(d, { recursive: true, force: true }); };

  if (info.mode !== 'home') return { moved: false, reason: 'not-home-mode' };
  if (exists(info.dir)) return { moved: false, reason: 'target-exists' };
  if (!exists(info.legacyDir)) return { moved: false, reason: 'no-legacy' };
  if (!exists(P.join(info.legacyDir, 'apps'))) return { moved: false, reason: 'legacy-not-valid' };

  try {
    mkdir(P.dirname(info.dir));
    rename(info.legacyDir, info.dir);
    return { moved: true, via: 'rename' };
  } catch (e) {
    try {
      mkdir(info.dir);
      copy(info.legacyDir, info.dir);
      remove(info.legacyDir);
      return { moved: true, via: 'copy' };
    } catch (e2) {
      return { moved: false, reason: 'error: ' + (e2.message || e2) };
    }
  }
}

module.exports = { resolve, migrate, fsExists };
