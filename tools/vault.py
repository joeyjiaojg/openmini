#!/usr/bin/env python3
"""小盒子私有市场 · 加密仓打包工具

把「含第三方音源配置」的应用打包成密文，只有拿到账号口令的小盒子才能解开安装。
仓库里只存密文（catalog.enc / apps/*.enc）与公开参数（meta.json：salt、迭代次数），
没有任何明文接口地址、没有密钥、没有口令。

文件格式（每个 .enc 都一样）：
    b"OMV1" | 12 字节 nonce | AES-256-GCM 密文（含 16 字节 tag）
AAD = b"OMV1|" + 该文件在仓里的路径，例如 b"OMV1|catalog.enc"、b"OMV1|apps/ab12.enc"
因此文件被改名/互换会直接解密失败。

密钥：PBKDF2-HMAC-SHA256(account + "\\x1f" + password, salt, iter) -> 32 字节
（宿主 Java 侧用同样的手工 PBKDF2 实现，全部 Android 版本一致。）

用法：
    # 打包（src 里放 catalog.json 与 apps/*.zip）
    python box/tools/vault.py pack --src vault-src --out vault-out \
        --account joey --password 'xxx'

    # 看看里面有什么（校验口令）
    python box/tools/vault.py ls --dir vault-out --account joey --password 'xxx'

    # 取出某个包（本地验证）
    python box/tools/vault.py extract --dir vault-out --id music --out /tmp/music.zip \
        --account joey --password 'xxx'

src/catalog.json 结构：
{
  "apps": [
    {"id":"music","name":"音乐盒","version":"1.4.0","versionCode":9,
     "category":"娱乐","icon":"♪","desc":"…","zip":"apps/music-v1.4.0.zip","entitle":true}
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


def blob_name(app_id: str, salt: bytes) -> str:
    h = hashlib.sha256(salt + app_id.encode("utf-8")).hexdigest()[:16]
    return "apps/%s.enc" % h


def read_meta(d: str) -> dict:
    with open(os.path.join(d, "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def unlock(d: str, account: str, password: str) -> tuple:
    meta = read_meta(d)
    salt = base64.b64decode(meta["salt"])
    key = derive_key(account, password, salt, int(meta.get("iter", KDF_ITER)))
    with open(os.path.join(d, meta["catalog"]), "rb") as f:
        raw = f.read()
    try:
        plain = decrypt(key, raw, meta["catalog"])
    except Exception:
        raise SystemExit("口令不对（或文件被改动）")
    return meta, key, json.loads(plain.decode("utf-8"))


def cmd_pack(a) -> None:
    src, out = a.src, a.out
    with open(os.path.join(src, "catalog.json"), encoding="utf-8") as f:
        catalog = json.load(f)
    salt = secrets.token_bytes(SALT_LEN)
    key = derive_key(a.account, a.password, salt)
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
        rel = blob_name(app["id"], salt)
        enc = encrypt(key, raw, rel)
        with open(os.path.join(out, rel), "wb") as f:
            f.write(enc)
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
        f.write(encrypt(key, plain, cat_name))

    meta = {
        "v": 1,
        "kdf": "PBKDF2-HMAC-SHA256",
        "iter": KDF_ITER,
        "salt": base64.b64encode(salt).decode("ascii"),
        "catalog": cat_name,
        "updated": a.updated or "",
        "note": "全部文件 AES-256-GCM 加密；密钥由账号口令派生，本仓库不含任何密钥或明文。",
    }
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("完成：%d 个包 + catalog.enc -> %s" % (len(apps_out), out))


def cmd_ls(a) -> None:
    _, _, bundle = unlock(a.dir, a.account, a.password)
    print("私有市场 · %s" % bundle.get("updated", ""))
    for it in bundle.get("apps", []):
        print("  %-10s v%-8s %7d B  %s" % (it["id"], it.get("version", ""), it.get("size", 0),
                                           it.get("desc", "")[:40]))
    print("  配置项：%s" % ", ".join(bundle.get("cfg", {}).keys()))


def cmd_extract(a) -> None:
    meta, key, bundle = unlock(a.dir, a.account, a.password)
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
    p = argparse.ArgumentParser(description="小盒子私有市场加密仓工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    pk = sub.add_parser("pack", help="把明文源打包成密文仓")
    pk.add_argument("--src", required=True)
    pk.add_argument("--out", required=True)
    pk.add_argument("--account", required=True)
    pk.add_argument("--password", required=True)
    pk.add_argument("--updated", default="")
    pk.set_defaults(fn=cmd_pack)

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
