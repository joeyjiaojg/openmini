package com.openmini.host;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 应用包仓库：包存在 files/apps/&lt;id&gt;/ 下，每个包必须带 manifest.json。
 * 升级安装只替换目录，不动 WebView 的 localStorage —— 存档自然保留。
 *
 * 所有来自包 manifest 的字段都当作不可信输入处理：
 *  - id / entry / icon 必须过白名单正则，且路径不得逃出包目录
 *  - name 去掉控制字符并截断
 *  - zip 条目数、解压总量都有上限
 *  - 记录每个包的 sha256 与安装来源，便于事后审计
 */
public class AppStore {

    private static final String TAG = "box";
    private static final long MAX_UNZIP = 40L * 1024 * 1024;
    private static final int MAX_ENTRIES = 2000;
    private static final int MAX_PATH = 200;
    static final String ID_RE = "[a-z0-9][a-z0-9_-]{0,39}";
    /** host 是启动器的虚拟域名，包不能占用 */
    private static final String RESERVED_ID = "host";
    private static final String PATH_RE = "[A-Za-z0-9._/-]{1,180}";

    final Context ctx;
    final File root;
    private final File stageRoot;

    public AppStore(Context c) {
        ctx = c;
        root = new File(c.getFilesDir(), "apps");
        if (!root.exists()) root.mkdirs();
        stageRoot = new File(c.getCacheDir(), "stage");
    }

    public boolean validId(String id) {
        return id != null && id.matches(ID_RE) && !RESERVED_ID.equals(id);
    }

    public File dir(String id) {
        if (!validId(id)) throw new IllegalArgumentException("bad id");
        return new File(root, id);
    }

    /** 首次启动把打包进 APK 的 .zip 装到内部存储；只做一次，删掉不会自动复活 */
    public void seedBuiltins() {
        SharedPreferences sp = ctx.getSharedPreferences("box", Context.MODE_PRIVATE);
        if (sp.getBoolean("seeded", false)) return;
        try {
            String[] names = ctx.getAssets().list("apps");
            if (names != null) {
                for (String n : names) {
                    if (!n.endsWith(".zip")) continue;
                    InputStream in = ctx.getAssets().open("apps/" + n);
                    try {
                        Result r = install(in, "builtin");
                        Log.i(TAG, "seed " + n + " -> " + r.msg);
                    } catch (Exception e) {
                        Log.w(TAG, "seed " + n + " failed", e);
                    } finally {
                        closeQuietly(in);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "seed failed", e);
        }
        sp.edit().putBoolean("seeded", true).apply();
    }

    public static class Result {
        public boolean ok;
        public String msg;
        public JSONObject app;

        public String toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("ok", ok);
                o.put("msg", msg == null ? "" : msg);
                if (app != null) o.put("app", app);
            } catch (Exception ignored) {
            }
            return o.toString();
        }
    }

    private static Result fail(String msg) {
        Result r = new Result();
        r.ok = false;
        r.msg = msg;
        return r;
    }

    /** 从 zip 流安装或升级一个包 */
    public Result install(InputStream in, String hint) {
        File stage = new File(stageRoot, "s" + System.nanoTime());
        try {
            deleteRec(stage);
            if (!stage.mkdirs()) return fail("无法创建临时目录");

            MessageDigest md = MessageDigest.getInstance("SHA-256");
            unzip(new DigestInputStream(in, md), stage);
            String sha = hex(md.digest());

            File src = stage;
            if (!new File(src, "manifest.json").isFile()) {
                File[] kids = src.listFiles();
                if (kids != null && kids.length == 1 && kids[0].isDirectory()
                        && new File(kids[0], "manifest.json").isFile()) {
                    src = kids[0];
                } else {
                    return fail("包里没有 manifest.json");
                }
            }

            JSONObject m;
            try {
                m = new JSONObject(readText(new File(src, "manifest.json")));
            } catch (Exception e) {
                return fail("manifest.json 解析失败");
            }

            String id = m.optString("id", "").trim().toLowerCase(Locale.US);
            if (!validId(id)) {
                return fail("manifest 的 id 只能用 0-9、a-z、- 和 _（最长 40，host 保留）");
            }

            String name = cleanName(m.optString("name", ""), id);

            String entry = safeRelPath(m.optString("entry", "index.html"));
            if (entry == null) return fail("入口路径非法");
            if (!new File(src, entry).isFile()) return fail("入口文件不存在: " + entry);

            String icon = null;
            if (m.has("icon")) {
                String ic = safeRelPath(m.optString("icon", ""));
                if (ic != null && new File(src, ic).isFile()) icon = ic;
            }

            m.put("id", id);
            m.put("name", name);
            m.put("entry", entry);
            if (icon == null) m.remove("icon");
            else m.put("icon", icon);
            m.put("sha256", sha);
            m.put("source", hint == null ? "" : hint);

            File dest = dir(id);
            boolean upgrade = dest.exists();
            File old = new File(root, "." + id + ".old");
            deleteRec(old);
            if (upgrade && !dest.renameTo(old)) {
                // 重命名失败就直接删（存档在 localStorage，不在目录里）
                deleteRec(dest);
                upgrade = false;
            }
            if (!src.renameTo(dest)) {
                copyDir(src, dest);
                deleteRec(src);
            }
            deleteRec(old);
            deleteRec(stage);

            rememberMeta(id, sha, hint, dirSize(dest));
            cspCache.remove(id);

            Result r = new Result();
            r.ok = true;
            r.msg = (upgrade ? "已更新 " : "已安装 ") + name;
            r.app = m;
            return r;
        } catch (Exception e) {
            deleteRec(stage);
            String msg = e.getMessage();
            if (msg == null || msg.length() == 0) msg = e.getClass().getSimpleName();
            return fail("安装失败: " + msg);
        }
    }

    /** manifest.csp 缓存：拦截器每个请求都会查，避免反复读盘解析 */
    private final HashMap<String, String> cspCache = new HashMap<String, String>();

    /**
     * 包可选声明自己的 CSP（manifest "csp" 字段）。装进来的代码再想引第三方
     * 脚本/外发数据会被这层头挡住。只放行安全字符，杜绝响应头注入；没有声明
     * 或内容非法时返回 null（不加头，兼容旧包）。
     */
    public String cspOf(String id) {
        String cached = cspCache.get(id);
        if (cached != null) return cached.length() == 0 ? null : cached;
        JSONObject m = get(id);
        String c = m == null ? "" : m.optString("csp", "");
        if (c.length() > 600 || !c.matches("[A-Za-z0-9 ;:'\"=/,._!*-]{0,600}")) c = "";
        cspCache.put(id, c);
        return c.length() == 0 ? null : c;
    }

    /** 包名只用于展示：去控制字符、限长 */
    private static String cleanName(String raw, String fallback) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length() && sb.length() < 40; i++) {
            char c = raw.charAt(i);
            if (c >= 0x20 && c != 0x7f) sb.append(c);
        }
        String s = sb.toString().trim();
        return s.length() == 0 ? fallback : s;
    }

    /** 相对路径白名单：不许绝对路径、不许 ..、不许反斜杠 */
    static String safeRelPath(String raw) {
        if (raw == null) return null;
        String p = raw.trim().replace('\\', '/');
        while (p.startsWith("/")) p = p.substring(1);
        if (p.length() == 0 || p.length() > MAX_PATH) return null;
        if (!p.matches(PATH_RE)) return null;
        if (p.contains("..")) return null;
        for (String seg : p.split("/")) {
            if (seg.length() == 0 || seg.startsWith(".")) return null;
        }
        return p;
    }

    private void rememberMeta(String id, String sha, String source, long bytes) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences("pkgmeta", Context.MODE_PRIVATE);
            JSONObject o = new JSONObject();
            o.put("sha256", sha);
            o.put("source", source == null ? "" : source);
            o.put("bytes", bytes);
            o.put("at", System.currentTimeMillis());
            sp.edit().putString(id, o.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** 供界面/审计用：某包的 sha256 与来源 */
    public JSONObject meta(String id) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences("pkgmeta", Context.MODE_PRIVATE);
            String s = sp.getString(id, null);
            return s == null ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    public String listJson() {
        JSONArray arr = new JSONArray();
        File[] kids = root.listFiles();
        List<File> dirs = new ArrayList<File>();
        if (kids != null) {
            for (File f : kids) {
                if (f.isDirectory() && !f.getName().startsWith(".") && validId(f.getName())) dirs.add(f);
            }
        }
        Collections.sort(dirs, new Comparator<File>() {
            public int compare(File a, File b) {
                return a.getName().compareTo(b.getName());
            }
        });
        for (File d : dirs) {
            try {
                JSONObject m = new JSONObject(readText(new File(d, "manifest.json")));
                m.put("id", d.getName());
                m.put("bytes", dirSize(d));
                m.put("name", cleanName(m.optString("name", ""), d.getName()));
                arr.put(m);
            } catch (Exception ignored) {
                // 缺 manifest 的目录直接跳过，不阻塞列表
            }
        }
        return arr.toString();
    }

    public JSONObject get(String id) {
        try {
            JSONObject m = new JSONObject(readText(new File(dir(id), "manifest.json")));
            m.put("id", id);
            m.put("name", cleanName(m.optString("name", ""), id));
            return m;
        } catch (Exception e) {
            return null;
        }
    }

    public String entryOf(String id) {
        JSONObject m = get(id);
        String e = m == null ? null : safeRelPath(m.optString("entry", "index.html"));
        return e == null ? "index.html" : e;
    }

    public boolean remove(String id) {
        if (!validId(id)) return false;
        try {
            cspCache.remove(id);
            ctx.getSharedPreferences("pkgmeta", Context.MODE_PRIVATE).edit().remove(id).apply();
            return deleteRec(dir(id));
        } catch (Exception e) {
            return false;
        }
    }

    private void unzip(InputStream in, File dest) throws IOException {
        String rootPath = dest.getCanonicalPath() + File.separator;
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(in));
        byte[] buf = new byte[16384];
        long total = 0;
        int count = 0;
        ZipEntry e;
        while ((e = zis.getNextEntry()) != null) {
            if (++count > MAX_ENTRIES) throw new IOException("包内文件过多");
            String nm = e.getName().replace('\\', '/');
            if (nm.length() == 0 || nm.startsWith("__MACOSX/") || nm.equals("__MACOSX")) continue;
            if (nm.length() > MAX_PATH || nm.indexOf('\0') >= 0) throw new IOException("包内路径非法: " + nm);
            File out = new File(dest, nm);
            String cp = out.getCanonicalPath();
            if (!cp.startsWith(rootPath)) throw new IOException("包内路径非法: " + nm);
            if (e.isDirectory()) {
                out.mkdirs();
                continue;
            }
            File parent = out.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            FileOutputStream fo = new FileOutputStream(out);
            try {
                int n;
                while ((n = zis.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_UNZIP) throw new IOException("包解压后超过 40MB");
                    fo.write(buf, 0, n);
                }
            } finally {
                closeQuietly(fo);
            }
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) {
            String h = Integer.toHexString(x & 0xff);
            if (h.length() == 1) sb.append('0');
            sb.append(h);
        }
        return sb.toString();
    }

    static String readText(File f) throws IOException {
        FileInputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), "UTF-8");
        } finally {
            closeQuietly(in);
        }
    }

    static long dirSize(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long sum = 0;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) sum += dirSize(k);
        return sum;
    }

    static void copyDir(File from, File to) throws IOException {
        if (from.isDirectory()) {
            if (!to.exists() && !to.mkdirs()) throw new IOException("无法创建 " + to);
            File[] kids = from.listFiles();
            if (kids != null) for (File k : kids) copyDir(k, new File(to, k.getName()));
        } else {
            File parent = to.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            FileInputStream in = new FileInputStream(from);
            try {
                FileOutputStream out = new FileOutputStream(to);
                try {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                } finally {
                    closeQuietly(out);
                }
            } finally {
                closeQuietly(in);
            }
        }
    }

    static boolean deleteRec(File f) {
        if (f == null || !f.exists()) return false;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRec(k);
        }
        return f.delete();
    }

    static void closeQuietly(java.io.Closeable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
            }
        }
    }
}
