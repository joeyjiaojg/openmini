#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-pkg.py — 把一个 H5 目录打成小游盒应用包（.zip）

用法：
  python make-pkg.py <源目录> [--id xiangqi] [--name 楚汉象棋] [--version 1.8.0]
                     [--version-code 9] [--icon icon.png] [--entry index.html]
                     [-o 输出路径]

规则：
  - 源目录必须有入口文件（默认 index.html）
  - 若源目录已有 manifest.json，则读取后用命令行参数覆盖
  - 产物 zip 的根目录直接是 manifest.json + 入口 + 资源
  - 同名 id 装到盒子里是覆盖升级，localStorage 存档不动
"""
import argparse
import json
import os
import sys
import zipfile


def detect_defaults(src):
    d = {"id": os.path.basename(os.path.abspath(src)).lower(),
         "name": os.path.basename(os.path.abspath(src)),
         "version": "1.0",
         "versionCode": 1,
         "entry": "index.html"}
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="源目录")
    ap.add_argument("--id")
    ap.add_argument("--name")
    ap.add_argument("--version")
    ap.add_argument("--version-code", type=int)
    ap.add_argument("--icon")
    ap.add_argument("--entry")
    ap.add_argument("-o", "--output")
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    if not os.path.isdir(src):
        sys.exit("源目录不存在: %s" % src)

    man = {}
    man_path = os.path.join(src, "manifest.json")
    if os.path.isfile(man_path):
        with open(man_path, encoding="utf-8") as f:
            man = json.load(f)

    defaults = detect_defaults(src)
    for k in ("id", "name", "version", "entry"):
        if getattr(args, k):
            man[k] = getattr(args, k)
        if k not in man:
            man[k] = defaults[k]
    if args.version_code is not None:
        man["versionCode"] = args.version_code
    if args.icon:
        man["icon"] = args.icon
    man.setdefault("versionCode", 1)

    entry = man["entry"]
    while entry.startswith("/"):
        entry = entry[1:]
    man["entry"] = entry

    if not os.path.isfile(os.path.join(src, entry)):
        sys.exit("入口文件不存在: %s" % os.path.join(src, entry))

    if man.get("icon") and not os.path.isfile(os.path.join(src, man["icon"])):
        print("[warn] icon 不存在，忽略: %s" % man["icon"])
        man.pop("icon", None)

    out = args.output or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "dist",
        "%s-v%s.zip" % (man["id"], man["version"]))
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    tmp_manifest = None
    if not os.path.isfile(man_path):
        tmp_manifest = man_path

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("manifest.json", json.dumps(man, ensure_ascii=False, indent=2))
        for root, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__MACOSX")]
            for fn in sorted(files):
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                if rel == "manifest.json":
                    continue
                if fn.startswith(".") or rel.startswith("tools/"):
                    continue
                z.write(full, rel)
                count += 1

    if tmp_manifest:
        pass

    size = os.path.getsize(out)
    print("[pkg] %s" % out)
    print("      id=%s  name=%s  version=%s(%s)  文件 %d 个  %.1f KB"
          % (man["id"], man["name"], man["version"], man.get("versionCode"), count, size / 1024.0))


if __name__ == "__main__":
    main()
