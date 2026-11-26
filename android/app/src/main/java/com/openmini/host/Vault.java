package com.openmini.host;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 私有市场（加密仓）客户端。
 *
 * 仓库里只有密文：meta.json（salt/迭代次数，公开）、catalog.enc、apps/*.enc。
 * 口令在本机派生成 AES-256 密钥，解开 catalog 才拿到应用清单与「音源配置」，
 * 因此没口令的人拿到仓库也装不了、也用不了内置接口。
 *
 * 两条取数通道：
 *  1) 私有仓（private repo）：填了只读 token 才走，走 GitHub API，最彻底；
 *  2) 密文镜像（public repo）：不填 token 时走这里，只有密文，无密钥不可读。
 */
class Vault {

    interface Cb {
        void done(JSONObject o);
    }

    interface Progress {
        void pct(int p);
    }

    /** 密文镜像（公开仓库，只有 .enc） */
    private static final String MIRROR_BASE =
            "https://gh-proxy.org/https://raw.githubusercontent.com/joeyjiaojg/openmini-vault/main/";
    private static final String MIRROR_BASE_DIRECT =
            "https://raw.githubusercontent.com/joeyjiaojg/openmini-vault/main/";
    /** 私有仓（私有仓库，走 API；需要只读 token） */
    private static final String PRIVATE_API =
            "https://api.github.com/repos/joeyjiaojg/openmini-market-private/contents/vault/";
    /** 想彻底私有：在这里填一个只读（Contents: Read）且只授权该仓库的 fine-grained PAT，重新打包宿主 */
    private static final String PRIVATE_TOKEN = "";

    private static final byte[] MAGIC = {'O', 'M', 'V', '1'};
    private static final int NONCE_LEN = 12;
    private static final int TAG_BITS = 128;

    private final Context ctx;
    private final AppStore store;
    private final SharedPreferences prefs;

    private byte[] key;              // 解密密钥（解锁后才有）
    private JSONObject catalog;      // 明文清单：apps[] + cfg{}
    private String user = "";

    Vault(Context c, AppStore store) {
        this.ctx = c.getApplicationContext();
        this.store = store;
        this.prefs = this.ctx.getSharedPreferences("vault", Context.MODE_PRIVATE);
    }

    boolean unlocked() {
        return key != null && catalog != null;
    }

    String user() {
        return user;
    }

    JSONObject stateJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", true);
            o.put("unlocked", unlocked());
            o.put("user", unlocked() ? user : "");
            o.put("count", unlocked() ? apps().length() : 0);
            o.put("remember", prefs.contains("k"));
        } catch (Exception ignored) {
        }
        return o;
    }

    JSONArray apps() {
        return catalog == null ? new JSONArray() : catalog.optJSONArray("apps");
    }

    /** 给某个应用下发的赋能配置；只有清单里配过的应用才拿得到 */
    String cfgFor(String appId) {
        if (!unlocked() || appId == null) return null;
        JSONObject cfg = catalog.optJSONObject("cfg");
        if (cfg == null) return null;
        JSONObject one = cfg.optJSONObject(appId);
        return one == null ? null : one.toString();
    }

    /** 启动时静默恢复「记住登录」的会话 */
    void restore() {
        final String savedKey = prefs.getString("k", null);
        final String savedUser = prefs.getString("u", "");
        if (savedKey == null) return;
        new Thread(new Runnable() {
            public void run() {
                try {
                    byte[] k;
                    try {
                        k = Base64.decode(savedKey, Base64.NO_WRAP);
                    } catch (Exception e) {
                        throw new IOException("保存的会话无效");
                    }
                    JSONObject cat = fetchCatalog(k);
                    synchronized (Vault.this) {
                        key = k;
                        catalog = cat;
                        user = savedUser;
                    }
                } catch (Exception e) {
                    prefs.edit().remove("k").remove("u").apply();
                    synchronized (Vault.this) {
                        key = null;
                        catalog = null;
                        user = "";
                    }
                }
            }
        }).start();
    }

    void unlock(final String account, final String password, final boolean remember, final Cb cb) {
        new Thread(new Runnable() {
            public void run() {
                JSONObject o = new JSONObject();
                try {
                    if (account == null || account.trim().length() == 0
                            || password == null || password.length() == 0) {
                        throw new IllegalArgumentException("账号和口令都要填");
                    }
                    JSONObject meta = new JSONObject(new String(fetchBytes("meta.json"), "UTF-8"));
                    int iter = meta.optInt("iter", 200000);
                    byte[] salt = Base64.decode(meta.optString("salt", ""), Base64.NO_WRAP);
                    if (salt.length < 8) throw new IOException("加密仓参数坏了");
                    byte[] k = pbkdf2((account.trim() + "\u001f" + password).getBytes("UTF-8"), salt, iter, 32);
                    JSONObject cat = fetchCatalog(k);
                    synchronized (Vault.this) {
                        key = k;
                        catalog = cat;
                        user = account.trim();
                    }
                    if (remember) {
                        prefs.edit()
                                .putString("k", Base64.encodeToString(k, Base64.NO_WRAP))
                                .putString("u", account.trim())
                                .apply();
                    } else {
                        prefs.edit().remove("k").remove("u").apply();
                    }
                    o.put("ok", true);
                    o.put("unlocked", true);
                    o.put("user", account.trim());
                    o.put("count", apps().length());
                    o.put("msg", "已解锁");
                } catch (Exception e) {
                    String m = e.getMessage();
                    if (e instanceof javax.crypto.AEADBadTagException) m = "账号或口令不对";
                    o = err(m == null ? "解锁失败" : m);
                }
                cb.done(o);
            }
        }).start();
    }

    void lock() {
        synchronized (this) {
            key = null;
            catalog = null;
            user = "";
        }
        prefs.edit().remove("k").remove("u").apply();
    }

    void list(final Cb cb) {
        JSONObject o = new JSONObject();
        try {
            if (!unlocked()) throw new IllegalStateException("未解锁");
            o.put("ok", true);
            o.put("unlocked", true);
            o.put("user", user);
            o.put("apps", apps());
        } catch (Exception e) {
            o = err(e.getMessage());
        }
        cb.done(o);
    }

    void install(final String id, final Progress prog, final Cb cb) {
        new Thread(new Runnable() {
            public void run() {
                JSONObject o = new JSONObject();
                File tmp = null;
                try {
                    final byte[] k;
                    synchronized (Vault.this) {
                        k = key;
                    }
                    if (k == null) throw new IOException("未解锁");
                    JSONObject app = null;
                    JSONArray arr = apps();
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject a = arr.getJSONObject(i);
                        if (id.equals(a.optString("id"))) {
                            app = a;
                            break;
                        }
                    }
                    if (app == null) throw new IOException("清单里没有这个应用");
                    String file = app.optString("file", "");
                    if (!file.startsWith("apps/") || file.contains("..")) throw new IOException("包地址不合法");
                    if (prog != null) prog.pct(5);
                    byte[] blob = fetchBytes(file);
                    if (prog != null) prog.pct(55);
                    // key 在解锁时写入，这里局部拷贝一份，避免并发锁定时被清空
                    byte[] zip = decrypt(k, blob, file);
                    String want = app.optString("sha256", "");
                    if (want.length() > 0) {
                        String got = sha256(zip);
                        if (!got.equalsIgnoreCase(want)) throw new IOException("包校验失败（可能被改动）");
                    }
                    if (prog != null) prog.pct(75);
                    tmp = new File(ctx.getCacheDir(), "vault-" + id + ".zip");
                    FileOutputStream fos = new FileOutputStream(tmp);
                    fos.write(zip);
                    fos.close();
                    AppStore.Result r = store.install(new FileInputStream(tmp), "vault");
                    if (prog != null) prog.pct(100);
                    if (!r.ok) throw new IOException(r.msg == null ? "安装失败" : r.msg);
                    o.put("ok", true);
                    o.put("msg", "已安装 " + app.optString("name", id));
                    o.put("app", r.app);
                } catch (Exception e) {
                    o = err(e.getMessage() == null ? "安装失败" : e.getMessage());
                } finally {
                    if (tmp != null) tmp.delete();
                }
                cb.done(o);
            }
        }).start();
    }

    // ---------- 取数与解密 ----------

    private JSONObject fetchCatalog(byte[] k) throws Exception {
        JSONObject meta = new JSONObject(new String(fetchBytes("meta.json"), "UTF-8"));
        String catPath = meta.optString("catalog", "catalog.enc");
        byte[] plain = decrypt(k, fetchBytes(catPath), catPath);
        return new JSONObject(new String(plain, "UTF-8"));
    }

    private byte[] fetchBytes(String path) throws IOException {
        IOException last = null;
        if (PRIVATE_TOKEN.length() > 0) {
            try {
                return http(PRIVATE_API + path + "?ref=main", PRIVATE_TOKEN);
            } catch (IOException e) {
                last = e;
            }
        }
        try {
            return http(MIRROR_BASE + path, null);
        } catch (IOException e) {
            last = e;
        }
        try {
            return http(MIRROR_BASE_DIRECT + path, null);
        } catch (IOException e) {
            last = e;
        }
        throw new IOException("拉不到加密仓（" + (last == null ? "网络错误" : last.getMessage()) + "）");
    }

    private static byte[] http(String urlStr, String token) throws IOException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "OpenMiniHost");
            if (token != null) {
                c.setRequestProperty("Authorization", "token " + token);
                c.setRequestProperty("Accept", "application/vnd.github.raw");
            }
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            return out.toByteArray();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static byte[] decrypt(byte[] key, byte[] blob, String path) throws Exception {
        if (blob.length < 4 + NONCE_LEN + 16) throw new IOException("密文损坏");
        for (int i = 0; i < 4; i++) {
            if (blob[i] != MAGIC[i]) throw new IOException("不是小盒子加密文件");
        }
        byte[] nonce = Arrays.copyOfRange(blob, 4, 4 + NONCE_LEN);
        byte[] ct = Arrays.copyOfRange(blob, 4 + NONCE_LEN, blob.length);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                new GCMParameterSpec(TAG_BITS, nonce));
        c.updateAAD(aad(path));
        return c.doFinal(ct);
    }

    private static byte[] aad(String path) throws Exception {
        byte[] p = path.getBytes("UTF-8");
        byte[] a = new byte[5 + p.length];
        System.arraycopy(MAGIC, 0, a, 0, 4);
        a[4] = '|';
        System.arraycopy(p, 0, a, 5, p.length);
        return a;
    }

    /** PBKDF2-HMAC-SHA256（自己实现：不依赖 API 26 才有的 SecretKeyFactory 变体） */
    private static byte[] pbkdf2(byte[] pw, byte[] salt, int iter, int len) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(pw, "HmacSHA256"));
        int hLen = 32;
        int blocks = (len + hLen - 1) / hLen;
        byte[] out = new byte[blocks * hLen];
        for (int i = 1; i <= blocks; i++) {
            mac.update(salt);
            mac.update(new byte[]{(byte) (i >>> 24), (byte) (i >>> 16), (byte) (i >>> 8), (byte) i});
            byte[] u = mac.doFinal();
            byte[] t = u.clone();
            for (int j = 1; j < iter; j++) {
                u = mac.doFinal(u);
                for (int k = 0; k < t.length; k++) t[k] ^= u[k];
            }
            System.arraycopy(t, 0, out, (i - 1) * hLen, hLen);
        }
        return Arrays.copyOf(out, len);
    }

    static String sha256(byte[] b) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("unlocked", false);
            o.put("msg", msg == null ? "失败" : msg);
        } catch (Exception ignored) {
        }
        return o;
    }
}
