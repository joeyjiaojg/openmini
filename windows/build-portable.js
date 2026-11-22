/* 打包免安装绿色版：Electron 运行时 + 宿主代码 → 一个 zip。
 * 解压后双击 OpenMini.exe 即用；data/ 目录首次运行自动创建，默认不装任何应用。
 * 用法：node build-portable.js [输出目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const ROOT = __dirname;
const DIST = process.argv[2] || path.join(ROOT, '..', 'dist');
const OUT = path.join(DIST, 'OpenMini-Windows-v1.0.0-portable.zip');
const APPDIR = 'OpenMini-Windows';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist');

function must(p, label) {
  if (!fs.existsSync(p)) { console.error('缺少 ' + label + ': ' + p); process.exit(1); }
}

function main() {
  must(ELECTRON, 'Electron 运行时（先 npm install）');
  must(path.join(ROOT, 'src', 'main.js'), '宿主源码');
  fs.mkdirSync(DIST, { recursive: true });

  const zip = new AdmZip();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'om-win-'));

  // 1) Electron 运行时全部文件，放进 APPDIR/
  function addDir(dir, prefix) {
    fs.readdirSync(dir).forEach(function (name) {
      if (name === 'default_app.asar') return;         // 换成我们的 app
      const full = path.join(dir, name);
      const rel = prefix + '/' + name;
      if (fs.statSync(full).isDirectory()) addDir(full, rel);
      else {
        // 重命名主程序：electron.exe → OpenMini.exe
        const out = (prefix === APPDIR && name === 'electron.exe') ? 'OpenMini.exe' : name;
        zip.addLocalFile(full, path.posix.dirname(rel), out);
      }
    });
  }
  addDir(ELECTRON, APPDIR);

  // 2) 我们的应用代码 → resources/app.asar 目录形式（无需 asar 工具）
  const appRoot = APPDIR + '/resources/app';
  ['main.js', 'preload.js'].forEach(function (f) {
    zip.addLocalFile(path.join(ROOT, 'src', f), appRoot, f);
  });
  ['index.html', 'style.css', 'host.js'].forEach(function (f) {
    zip.addLocalFile(path.join(ROOT, 'src', 'host', f), appRoot + '/host', f);
  });
  // 依赖：adm-zip 全部文件（0.5.x 结构：adm-zip.js + headers/methods/util + zipEntry/zipFile）
  addDir(path.join(ROOT, 'node_modules', 'adm-zip'), appRoot + '/node_modules/adm-zip');
  zip.addFile(appRoot + '/package.json', Buffer.from(JSON.stringify({
    name: 'openmini-app', version: '1.0.0', main: 'main.js',
    dependencies: { 'adm-zip': '0.5.18' }
  }, null, 2)));

  // 3) 说明文件
  zip.addFile(APPDIR + '/使用说明.txt', Buffer.from(
    'OpenMini 小盒子 Windows 免安装版 v1.0.0\r\n' +
    '========================================\r\n\r\n' +
    '1. 把整个 OpenMini-Windows 文件夹解压到任意位置（U 盘也可以）。\r\n' +
    '2. 双击 OpenMini.exe 启动，无需安装、不写注册表。\r\n' +
    '3. 首次启动会看到空盒子：应用市场里点「安装」即可添加应用。\r\n' +
    '4. 应用和存档都在本文件夹的 data\\ 下，拷走 data\\ 就是搬走全部应用和存档。\r\n' +
    '5. 应用内按 Esc 或 Alt+← 回到盒子；点应用图标打开，长按可删除。\r\n' +
    '6. 也可以把 .zip 应用包直接拖进来：点「＋ 装一个应用」→「本地文件」。\r\n' +
    '\r\n更多信息：https://github.com/joeyjiaojg/openmini\r\n', 'utf8'));

  zip.writeZip(OUT);
  const size = fs.statSync(OUT).size;
  console.log('打包完成: ' + OUT);
  console.log('体积: ' + (size / 1024 / 1024).toFixed(1) + ' MB');
  console.log('包内文件数: ' + zip.getEntries().length);
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { }
}

main();
