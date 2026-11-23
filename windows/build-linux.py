#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包 OpenMini Linux 免安装绿色版（Debian / Ubuntu x86_64）

产物：../dist/OpenMini-Linux-v1.0.0-x64.tar.gz
解压后 ./OpenMini 即可运行；默认零预装，数据统一放 ~/.openmini。

与 Windows 版共用同一套 Electron 宿主源码（src/），差异只在：
  - 运行时换成 electron-v37.10.3-linux-x64.zip
  - 产物用 tar.gz（保存 Unix 可执行权限，zip 在 Linux 上会丢 x 位）
  - 附带 .desktop 与 install-desktop.sh，便于「双击打开」
用法：python build-linux.py [输出目录]
"""
import io
import os
import sys
import time
import json
import zipfile
import tarfile
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = sys.argv[1] if len(sys.argv) > 1 else os.path.normpath(os.path.join(ROOT, '..', 'dist'))
OUT = os.path.join(DIST, 'OpenMini-Linux-v1.0.0-x64.tar.gz')
CACHE = os.path.join(ROOT, '.cache', 'electron-v37.10.3-linux-x64.zip')
URL = 'https://cdn.npmmirror.com/binaries/electron/37.10.3/electron-v37.10.3-linux-x64.zip'
PREFIX = 'OpenMini-Linux'

DESKTOP = '''[Desktop Entry]
Type=Application
Version=1.0
Name=小盒子 OpenMini
Name[en]=OpenMini
Comment=免安装的小应用宿主 · OpenMini portable host
Exec=sh -c 'p="$0"; p="${p#file://}"; exec "$(dirname "$p")/OpenMini"' %k
Icon=utilities-terminal
Terminal=false
Categories=Game;Utility;
StartupWMClass=OpenMini
'''

INSTALL_SH = '''#!/bin/sh
# 把小盒子加入应用菜单 / 桌面，生成带绝对路径且可信任的启动器。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
chmod +x "$DIR/OpenMini" "$DIR/chrome_crashpad_handler" 2>/dev/null || true
DESK_DIR="$HOME/.local/share/applications"
mkdir -p "$DESK_DIR"
DESK="$DESK_DIR/openmini.desktop"
cat > "$DESK" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=小盒子 OpenMini
Name[en]=OpenMini
Comment=免安装的小应用宿主 · OpenMini portable host
Exec="$DIR/OpenMini"
Icon="$DIR/icon.png"
Terminal=false
Categories=Game;Utility;
StartupWMClass=OpenMini
EOF
chmod 644 "$DESK"
if [ -d "$HOME/Desktop" ]; then
  cp "$DESK" "$HOME/Desktop/OpenMini.desktop"
  chmod +x "$HOME/Desktop/OpenMini.desktop"
  if command -v gio >/dev/null 2>&1; then
    gio set "$HOME/Desktop/OpenMini.desktop" metadata::trusted true 2>/dev/null || true
  fi
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESK_DIR" 2>/dev/null || true
fi
echo "完成：在应用菜单搜索「小盒子」，或双击桌面 OpenMini 图标即可启动。"
echo "数据在 ~/.openmini/ ；如需便携模式，在本目录建一个空的 portable.txt 。"
'''

README = '''OpenMini 小盒子 Linux 免安装版 v1.0.0 (x86_64)
================================================

适用：Debian / Ubuntu 及其衍生桌面版（64 位），GNOME / KDE / Xfce 均可。

【怎么启动】
1) 推荐（之后可以双击桌面图标）：
     cd 本目录 && ./install-desktop.sh
   然后应用菜单搜索「小盒子」，或双击桌面上的 OpenMini 图标。
   这个脚本会生成带绝对路径的 .desktop 并标记为可信，绕过 GNOME 对
   「未信任启动器」的拦截。

2) 直接运行：  ./OpenMini
   文件管理器里双击 OpenMini 时若提示「不可信」，选择「运行」即可。

3) 也可以双击 OpenMini.desktop（首次可能需右键 → 允许启动）。

【数据放在哪】
默认统一放在用户目录 ~/.openmini/ ，和 Windows 版一致；
程序目录只读（例如放在 /opt 或只读 U 盘）也能正常使用。
  · 想「整个文件夹拷走」：在本目录新建一个空的 portable.txt，
    数据就留在本目录 data/ 下，拷走整个文件夹即是完整迁移。
  · 也可用环境变量 OPENMINI_DATA 指定任意目录，例如：
      OPENMINI_DATA=/mnt/usb/om-data ./OpenMini

【卸载】
删掉本文件夹即可；如需连存档一起清掉，再删 ~/.openmini/ 。
应用菜单入口 ~/.local/share/applications/openmini.desktop 可一并删除。

【若启动报缺少系统库】
  sudo apt install -y libgtk-3-0 libnss3 libasound2 libxss1 libgbm1 libdrm2 libxkbcommon0
（大多数桌面版已自带，一般不需要执行。）

【关于 Chromium 沙箱】
绿色版无法给 chrome-sandbox 设置 setuid root，程序检测到后会自动降级为
--no-sandbox 启动。如果需要完整沙箱，可执行：
  sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
程序检测到 setuid 位后会自动恢复沙箱，无需改任何代码。

更多信息：https://github.com/joeyjiaojg/openmini
'''


def make_icon():
    """256x256 深色金主题「盒」字图标，返回 PNG bytes。"""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None
    S = 256
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    gold = (201, 161, 90, 255)
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=56, fill=(26, 22, 16, 255), outline=gold, width=7)
    f = None
    for p in ['C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/simhei.ttf',
              '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
              '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc']:
        if os.path.exists(p):
            try:
                f = ImageFont.truetype(p, 140)
                break
            except Exception:
                pass
    if f:
        bb = d.textbbox((0, 0), '盒', font=f)
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        d.text(((S - w) / 2, (S - h) / 2 - 18), '盒', font=f, fill=gold)
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


def local_files():
    """我们自己的应用代码，返回 [(包内相对路径, bytes, mode)]。"""
    out = []
    src = os.path.join(ROOT, 'src')

    def read(p):
        with open(p, 'rb') as f:
            return f.read()

    for name in ['main.js', 'preload.js', 'paths.js']:
        out.append(('resources/app/' + name, read(os.path.join(src, name)), 0o644))
    for name in ['index.html', 'style.css', 'host.js']:
        out.append(('resources/app/host/' + name, read(os.path.join(src, 'host', name)), 0o644))
    out.append(('resources/app/package.json', json.dumps({
        'name': 'openmini-app', 'version': '1.1.0', 'main': 'main.js',
        'dependencies': {'adm-zip': '0.5.18'}
    }, indent=2).encode('utf-8'), 0o644))

    adm = os.path.join(ROOT, 'node_modules', 'adm-zip')
    if not os.path.isdir(adm):
        print('错误：缺少 adm-zip，请先 npm install', file=sys.stderr)
        sys.exit(1)
    for base, _dirs, files in os.walk(adm):
        for fn in files:
            full = os.path.join(base, fn)
            rel = os.path.relpath(full, adm).replace(os.sep, '/')
            out.append(('resources/app/node_modules/adm-zip/' + rel, read(full), 0o644))

    icon = make_icon()
    if icon:
        out.append(('icon.png', icon, 0o644))
    out.append(('OpenMini.desktop', DESKTOP.encode('utf-8'), 0o755))
    out.append(('install-desktop.sh', INSTALL_SH.encode('utf-8').replace(b'\r\n', b'\n'), 0o755))
    out.append(('使用说明.txt', README.encode('utf-8'), 0o644))
    return out


def main():
    if not os.path.exists(CACHE):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        print('下载 Electron Linux 运行时...')
        subprocess.check_call(['curl', '-L', '--retry', '2', '-m', '480', '-s', '-o', CACHE, URL])
    os.makedirs(DIST, exist_ok=True)

    z = zipfile.ZipFile(CACHE)
    entries = [i for i in z.infolist() if not i.is_dir()]
    own = local_files()

    # 收集所有目录，保证 tar 里目录项齐全且有序
    dirs = set()
    for i in entries:
        name = 'OpenMini' if i.filename == 'electron' else i.filename
        parts = name.split('/')[:-1]
        for k in range(1, len(parts) + 1):
            dirs.add('/'.join(parts[:k]))
    for rel, _b, _m in own:
        parts = rel.split('/')[:-1]
        for k in range(1, len(parts) + 1):
            dirs.add('/'.join(parts[:k]))

    now = int(time.time())
    with tarfile.open(OUT, 'w:gz', compresslevel=6) as tar:
        root = tarfile.TarInfo(PREFIX)
        root.type, root.mode, root.mtime, root.uid, root.gid = tarfile.DIRTYPE, 0o755, now, 0, 0
        tar.addfile(root)
        for d in sorted(dirs):
            ti = tarfile.TarInfo(PREFIX + '/' + d)
            ti.type, ti.mode, ti.mtime, ti.uid, ti.gid = tarfile.DIRTYPE, 0o755, now, 0, 0
            tar.addfile(ti)

        for i in entries:
            if i.filename == 'resources/default_app.asar':
                continue
            name = 'OpenMini' if i.filename == 'electron' else i.filename
            ti = tarfile.TarInfo(PREFIX + '/' + name)
            ti.mode = ((i.external_attr >> 16) & 0o7777) or 0o644
            ti.size, ti.mtime, ti.uid, ti.gid = i.file_size, now, 0, 0
            with z.open(i) as fp:
                tar.addfile(ti, fp)

        for rel, data, mode in own:
            ti = tarfile.TarInfo(PREFIX + '/' + rel)
            ti.mode, ti.size, ti.mtime, ti.uid, ti.gid = mode, len(data), now, 0, 0
            tar.addfile(ti, io.BytesIO(data))

    z.close()
    size = os.path.getsize(OUT)
    with tarfile.open(OUT, 'r:gz') as t:
        n = len(t.getmembers())
    print('打包完成: ' + OUT)
    print('体积: %.1f MB' % (size / 1024 / 1024))
    print('包内条目数: %d (Electron %d + 自有 %d + 目录 %d)' % (n, len(entries) - 1, len(own), len(dirs) + 1))


if __name__ == '__main__':
    main()
