#!/usr/bin/env python3
"""小盒子私有市场 · 加密仓打包工具（多账号版）

把「含第三方音源配置」的应用打包成密文，只有拿到账号口令的小盒子才能解开安装。
仓库里只存密文（catalog.enc / apps/*.enc）与公开参数（meta.json：盐、迭代次数、密钥信封），
没有任何明文接口地址、没有密钥、没有口令。

结构（v2，支持多账号）：
    主密钥 MK（32B 随机）    —— 只用来加密 catalog.enc 与 apps/*.enc
    每个账号一把 KEK         —— PBKDF2-HMAC-SHA256(账号 + "\\x1f" + 口令, 自己的 salt, iter)
    信封 wrap = AES-256-GCM(KEK, MK, AAD="wrap/<账号名>")   —— 存在 meta.json 里

所以：加/删账号只改 meta.json 里的 users[]，不用重新加密任何应用包；
      换某人的口令也只重写他那一条信封，别人不受影响。

每个 .enc 文件的格式：
    b"OMV1" | 12 字节 nonce | AES-256-GCM 密文（含 16 字节 tag）
AAD = b"OMV1|" + 该文件在仓里的路径，例如 b"OMV1|catalog.enc"、b"OMV1|apps/ab12.enc"
因此文件被改名/互换会直接解密失败。

用法：
    # 打包（src 里放 catalog.json 与 apps/*.zip）；--extra-user 可重复，加多个账号
    python box/tools/vault.py pack --src vault-src --out vault-out \
        --account joey --password 'xxx' --extra-user 'friend:yyy'

    # 给仓里加一个账号（要先用已有账号解开）
    python box/tools/vault.py adduser --dir vault-out \
        --account joey --password 'xxx' --new-account friend --new-password 'yyy'

    # 改某个账号的口令（不动主密钥，应用包不用重传）
    python box/tools/vault.py passwd --dir vault-out \
        --account joey --password 'xxx' --target friend --new-password 'zzz'

    # 删账号 / 看账号列表
    python box/tools/vault.py deluser --dir vault-out --account joey --password 'xxx' --target friend
    python box/tools/vault.py lsusers --dir vault-out

    # 看看里面有什么 / 取出某个包（本地验证）
    python box/tools/vault.py ls --dir vault-out --account joey --password 'xxx'
    python box/tools/vault.py extract --dir vault-out --id music --out /tmp/music.zip \
        --account joey --password 'xxx'

src/catalog.json 结构：
{
  "apps": [
    {"id":"music","name":"音乐盒","version":"1.4.1","versionCode":10,
     "category":"娱乐","icon":"♪","desc":"…","zip":"apps/music-v1.4.1.zip","entitle":true}
  ],
  "cfg": { "music": { …只下发给已解锁宿主的配置… } }
}
"""
import argparse
import base64
import hashlib
import json
import os
import secrets
import sys

MAGIC = b"OMV1"
KDF_ITER = 200000
SALT_LEN = 16
NONCE_LEN = 12


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def b64d(s: str) -> bytes:
    return base64.b64decode(s or "")


def derive_key(account: str, password: str, salt: bytes, iters: int = KDF_ITER) -> bytes:
    pw = (account + "\x1f" + password).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", pw, salt, iters, 32)


def encrypt(key: bytes, plain: bytes, aad_path: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = secrets.token_bytes(NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plain, MAGIC + b"|" + aad_path.encode("utf-8"))
    return MAGIC + nonce + ct


def decrypt(key: bytes, blob: bytes, aad_path: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + NONCE_LEN + 16:
        raise ValueError("不是有效的加密文件")
    nonce = blob[4:4 + NONCE_LEN]
    ct = blob[4 + NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ct, MAGIC + b"|" + aad_path.encode("utf-8"))


def blob_name(app_id: str, vid: bytes) -> str:
    h = hashlib.sha256(vid + app_id.encode("utf-8")).hexdigest()[:16]
    return "apps/%s.enc" % h


def read_meta(d: str) -> dict:
    with open(os.path.join(d, "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def write_meta(d: str, meta: dict) -> None:
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


def wrap_path(name: str) -> str:
    return "wrap/" + name


def make_entry(name: str, password: str, master: bytes) -> dict:
    salt = secrets.token_bytes(SALT_LEN)
    kek = derive_key(name, password, salt, KDF_ITER)
    return {
        "name": name,
        "salt": b64e(salt),
        "iter": KDF_ITER,
        "wrap": b64e(encrypt(kek, master, wrap_path(name))),
    }


def open_master(meta: dict, account: str, password: str) -> tuple:
    """用账号口令解开主密钥，返回 (master, 规范化账号名)。兼容 v1（单账号、无信封）。"""
    users = meta.get("users") or []
    if users:
        low = (account or "").lower()
        same = [u for u in users if str(u.get("name", "")).lower() == low]
        rest = [u for u in users if str(u.get("name", "")).lower() != low]
        for u in same + rest:
            name = str(u.get("name", ""))
            try:
                kek = derive_key(name, password, b64d(u["salt"]), int(u.get("iter", KDF_ITER)))
                mk = decrypt(kek, b64d(u["wrap"]), wrap_path(name))
                if len(mk) == 32:
                    return mk, name
            except Exception:
                continue
        raise SystemExit("账号或口令不对（或 meta.json 被改动）")
    # v1：口令直接派生成文件密钥
    salt = b64d(meta.get("salt", ""))
    if len(salt) < 8:
        raise SystemExit("加密仓参数坏了")
    return derive_key(account, password, salt, int(meta.get("iter", KDF_ITER))), account


def unlock(d: str, account: str, password: str) -> tuple:
    meta = read_meta(d)
    key, name = open_master(meta, account, password)
    cat = meta.get("catalog", "catalog.enc")
    with open(os.path.join(d, cat), "rb") as f:
        raw = f.read()
    try:
        plain = decrypt(key, raw, cat)
    except Exception:
        raise SystemExit("账号或口令不对（或文件被改动）")
    return meta, key, json.loads(plain.decode("utf-8")), name


def cmd_pack(a) -> None:
    src, out = a.src, a.out
    with open(os.path.join(src, "catalog.json"), encoding="utf-8") as f:
        catalog = json.load(f)

    users = []
    if a.account and a.password:
        users.append((a.account, a.password))
    for spec in (a.extra_user or []):
        if ":" not in spec:
            raise SystemExit("--extra-user 格式是 账号:口令")
        n, p = spec.split(":", 1)
        users.append((n, p))
    if not users:
        raise SystemExit("至少要有一个账号")

    master = secrets.token_bytes(32)
    vid = secrets.token_bytes(8)
    os.makedirs(os.path.join(out, "apps"), exist_ok=True)

    apps_out = []
    for app in catalog.get("apps", []):
        zip_rel = app.pop("zip", None)
        if not zip_rel:
            continue
        zip_path = os.path.join(src, zip_rel)
        if not os.path.isfile(zip_path):
            raise SystemExit("缺少包文件: " + zip_path)
        with open(zip_path, "rb") as f:
            raw = f.read()
        rel = blob_name(app["id"], vid)
        with open(os.path.join(out, rel), "wb") as f:
            f.write(encrypt(master, raw, rel))
        item = dict(app)
        item["file"] = rel
        item["size"] = len(raw)
        item["sha256"] = hashlib.sha256(raw).hexdigest()
        apps_out.append(item)
        print("  + %-12s %-8s %6d B -> %s" % (app["id"], app.get("version", ""), len(raw), rel))

    bundle = {
        "v": 1,
        "name": "openmini-market-private",
        "updated": a.updated or "",
        "apps": apps_out,
        "cfg": catalog.get("cfg", {}),
    }
    plain = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    cat_name = "catalog.enc"
    with open(os.path.join(out, cat_name), "wb") as f:
        f.write(encrypt(master, plain, cat_name))

    meta = {
        "v": 2,
        "kdf": "PBKDF2-HMAC-SHA256",
        "iter": KDF_ITER,
        "catalog": cat_name,
        "updated": a.updated or "",
        "users": [make_entry(n, p, master) for n, p in users],
        "note": "全部文件 AES-256-GCM 加密；主密钥随机生成，每个账号各有一份用口令派生的密钥信封，仓里不含密钥或明文。",
    }
    write_meta(out, meta)
    print("完成：%d 个包 + catalog.enc + %d 个账号 -> %s" % (len(apps_out), len(users), out))


def cmd_adduser(a) -> None:
    meta, master, _, _ = unlock(a.dir, a.account, a.password)
    users = meta.setdefault("users", [])
    name = a.new_account.strip()
    if not name:
        raise SystemExit("账号名不能为空")
    if any(str(u.get("name", "")).lower() == name.lower() for u in users):
        raise SystemExit("这个账号已存在，改口令请用 passwd")
    users.append(make_entry(name, a.new_password, master))
    meta["updated"] = a.updated or meta.get("updated", "")
    write_meta(a.dir, meta)
    print("已加入账号 %s（共 %d 个）——只需重新上传 meta.json，应用包不用动" % (name, len(users)))


def cmd_passwd(a) -> None:
    meta, master, _, _ = unlock(a.dir, a.account, a.password)
    users = meta.get("users") or []
    target = a.target.strip().lower()
    hit = None
    for u in users:
        if str(u.get("name", "")).lower() == target:
            hit = u
            break
    if hit is None:
        raise SystemExit("没有这个账号: " + a.target)
    users[users.index(hit)] = make_entry(str(hit["name"]), a.new_password, master)
    write_meta(a.dir, meta)
    print("已重置 %s 的口令——只需重新上传 meta.json" % hit["name"])


def cmd_deluser(a) -> None:
    meta, _, _, _ = unlock(a.dir, a.account, a.password)
    users = meta.get("users") or []
    if len(users) <= 1:
        raise SystemExit("这是最后一个账号，删掉就没人能解锁了")
    target = a.target.strip().lower()
    kept = [u for u in users if str(u.get("name", "")).lower() != target]
    if len(kept) == len(users):
        raise SystemExit("没有这个账号: " + a.target)
    meta["users"] = kept
    write_meta(a.dir, meta)
    print("已删除账号 %s（剩 %d 个）——重新上传 meta.json 后立刻生效" % (a.target, len(kept)))


def cmd_lsusers(a) -> None:
    meta = read_meta(a.dir)
    users = meta.get("users") or []
    if not users:
        print("v1 单账号仓（没有账号列表）")
        return
    print("共 %d 个账号：%s" % (len(users), "、".join(str(u.get("name", "")) for u in users)))


def cmd_ls(a) -> None:
    _, _, bundle, name = unlock(a.dir, a.account, a.password)
    print("私有市场 · %s · 解锁账号 %s" % (bundle.get("updated", ""), name))
    for it in bundle.get("apps", []):
        print("  %-10s v%-8s %7d B  %s" % (it["id"], it.get("version", ""), it.get("size", 0),
                                           it.get("desc", "")[:40]))
    print("  配置项：%s" % ", ".join(bundle.get("cfg", {}).keys()))


def cmd_extract(a) -> None:
    _, key, bundle, _ = unlock(a.dir, a.account, a.password)
    target = None
    for it in bundle.get("apps", []):
        if it["id"] == a.id:
            target = it
            break
    if not target:
        raise SystemExit("没有这个应用: " + a.id)
    with open(os.path.join(a.dir, target["file"]), "rb") as f:
        blob = f.read()
    raw = decrypt(key, blob, target["file"])
    digest = hashlib.sha256(raw).hexdigest()
    if digest != target.get("sha256"):
        raise SystemExit("sha256 不符，文件被改动")
    with open(a.out, "wb") as f:
        f.write(raw)
    print("已导出 %s v%s -> %s（sha256 校验通过）" % (a.id, target.get("version", ""), a.out))


def main() -> None:
    p = argparse.ArgumentParser(description="小盒子私有市场加密仓工具（多账号）")
    sub = p.add_subparsers(dest="cmd", required=True)

    pk = sub.add_parser("pack", help="把明文源打包成密文仓")
    pk.add_argument("--src", required=True)
    pk.add_argument("--out", required=True)
    pk.add_argument("--account", default="", help="第一个账号（仓主）")
    pk.add_argument("--password", default="", help="第一个账号的口令")
    pk.add_argument("--extra-user", action="append", default=[], help="额外账号，格式 账号:口令，可重复")
    pk.add_argument("--updated", default="")
    pk.set_defaults(fn=cmd_pack)

    au = sub.add_parser("adduser", help="给仓里加一个账号（只改 meta.json）")
    au.add_argument("--dir", required=True)
    au.add_argument("--account", required=True)
    au.add_argument("--password", required=True)
    au.add_argument("--new-account", required=True)
    au.add_argument("--new-password", required=True)
    au.add_argument("--updated", default="")
    au.set_defaults(fn=cmd_adduser)

    pw = sub.add_parser("passwd", help="重置某个账号的口令（只改 meta.json）")
    pw.add_argument("--dir", required=True)
    pw.add_argument("--account", required=True)
    pw.add_argument("--password", required=True)
    pw.add_argument("--target", required=True)
    pw.add_argument("--new-password", required=True)
    pw.set_defaults(fn=cmd_passwd)

    du = sub.add_parser("deluser", help="删掉某个账号（只改 meta.json）")
    du.add_argument("--dir", required=True)
    du.add_argument("--account", required=True)
    du.add_argument("--password", required=True)
    du.add_argument("--target", required=True)
    du.set_defaults(fn=cmd_deluser)

    lu = sub.add_parser("lsusers", help="列出账号")
    lu.add_argument("--dir", required=True)
    lu.set_defaults(fn=cmd_lsusers)

    ls = sub.add_parser("ls", help="解开 catalog 看看应用清单")
    ls.add_argument("--dir", required=True)
    ls.add_argument("--account", required=True)
    ls.add_argument("--password", required=True)
    ls.set_defaults(fn=cmd_ls)

    ex = sub.add_parser("extract", help="取出某个应用包")
    ex.add_argument("--dir", required=True)
    ex.add_argument("--id", required=True)
    ex.add_argument("--out", required=True)
    ex.add_argument("--account", required=True)
    ex.add_argument("--password", required=True)
    ex.set_defaults(fn=cmd_extract)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
