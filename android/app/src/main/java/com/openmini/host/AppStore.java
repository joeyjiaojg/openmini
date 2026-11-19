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
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 应用包仓库：包存在 files/apps/&lt;id&gt;/ 下，每个包必须带 manifest.json。
 * 升级安装只替换目录，不动 WebView 的 localStorage —— 存档自然保留。
 */
public class AppStore {

    private static final String TAG = "box";
    private static final long MAX_UNZIP = 40L * 1024 * 1024;

    final Context ctx;
    final File root;
    private final File stageRoot;

    public AppStore(Context c) {
        ctx = c;
        root = new File(c.getFilesDir(), "apps");
        if (!root.exists()) root.mkdirs();
        stageRoot = new File(c.getCacheDir(), "stage");
    }

    public File dir(String id) {
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
                        Result r = install(in, n);
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
            unzip(in, stage);

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
            if (!id.matches("[a-z0-9][a-z0-9_-]{0,39}")) {
                return fail("manifest 的 id 只能用 0-9、a-z、- 和 _（最长 40）");
            }
            String name = m.optString("name", "").trim();
            if (name.length() == 0) name = id;
            String entry = m.optString("entry", "index.html").trim();
            while (entry.startsWith("/")) entry = entry.substring(1);
            if (entry.length() == 0) entry = "index.html";
            if (!new File(src, entry).isFile()) return fail("入口文件不存在: " + entry);

            m.put("id", id);
            m.put("name", name);
            m.put("entry", entry);

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

    public String listJson() {
        JSONArray arr = new JSONArray();
        File[] kids = root.listFiles();
        List<File> dirs = new ArrayList<File>();
        if (kids != null) {
            for (File f : kids) {
                if (f.isDirectory() && !f.getName().startsWith(".")) dirs.add(f);
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
            return m;
        } catch (Exception e) {
            return null;
        }
    }

    public String entryOf(String id) {
        JSONObject m = get(id);
        String e = m == null ? null : m.optString("entry", "index.html");
        if (e == null || e.length() == 0) e = "index.html";
        while (e.startsWith("/")) e = e.substring(1);
        return e;
    }

    public boolean remove(String id) {
        return deleteRec(dir(id));
    }

    private void unzip(InputStream in, File dest) throws IOException {
        String rootPath = dest.getCanonicalPath() + File.separator;
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(in));
        byte[] buf = new byte[16384];
        long total = 0;
        ZipEntry e;
        while ((e = zis.getNextEntry()) != null) {
            String nm = e.getName().replace('\\', '/');
            if (nm.length() == 0 || nm.startsWith("__MACOSX/") || nm.equals("__MACOSX")) continue;
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
