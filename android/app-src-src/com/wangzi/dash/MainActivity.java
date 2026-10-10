package com.wangzi.dash;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.content.Intent;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * 门店经营数据 App：WebView 壳 + 原生网络桥。
 *
 * 取数方式与参照的 App 一致：手机直接登录思迅云（passport2 / 业务站），
 * 拿到票据后签名取报表，不经过局域网里的大屏电脑。
 *
 * 为什么必须有原生桥：页面在 file:// 下，浏览器不允许跨域，也拿不到 302 的
 * Location 与 Set-Cookie，登录流程只能靠原生 HTTP 才能走通。
 * JS 调 DashBridge.request(id, json)，原生完成后回调 DashBridgeCallback。
 */
public class MainActivity extends Activity {

    private static final String TAG = "WangZiDash";
    private static final int TIMEOUT_MS = 30000;

    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 账号与登录票据存在 localStorage
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "DashBridge");
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    private boolean handleUrl(String url) {
        String u = url == null ? "" : url;
        if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("file://")
                || u.startsWith("data:") || u.startsWith("about:")) {
            return false; // WebView 内部打开
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
        } catch (Exception ignored) {
        }
        return true;
    }

    /** 给网页用的取数通道 */
    final class Bridge {
        @JavascriptInterface
        public void request(final String id, final String json) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    String err = null;
                    String result = "{}";
                    try {
                        result = perform(new JSONObject(json == null ? "{}" : json));
                    } catch (Throwable t) {
                        err = String.valueOf(t == null ? "请求失败" : t.getMessage());
                        Log.w(TAG, "bridge request failed: " + err);
                    }
                    final String e = err;
                    final String r = result;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            callback(id, e, r);
                        }
                    });
                }
            });
        }
    }

    private void callback(String id, String err, String json) {
        if (web == null) return;
        try {
            String argId = JSONObject.quote(id == null ? "" : id);
            String argErr = err == null ? "null" : JSONObject.quote(err);
            String argJson = JSONObject.quote(json == null ? "{}" : json);
            web.evaluateJavascript("DashBridgeCallback(" + argId + "," + argErr + "," + argJson + ")", null);
        } catch (Throwable t) {
            Log.e(TAG, "callback failed", t);
        }
    }

    /** 一次 HTTP：返回 {status, headers:{键名小写}, body} */
    String perform(JSONObject req) throws Exception {
        URL u = new URL(req.getString("url"));
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        try {
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            // 登录靠 302 的 Location 找业务站，所以默认不跟随跳转
            c.setInstanceFollowRedirects(req.optBoolean("followRedirects", false));
            c.setRequestMethod(String.valueOf(req.optString("method", "GET")).toUpperCase(Locale.US));

            boolean hasEncoding = false;
            JSONObject headers = req.optJSONObject("headers");
            if (headers != null) {
                Iterator<String> it = headers.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (k != null && k.equalsIgnoreCase("Accept-Encoding")) hasEncoding = true;
                    c.setRequestProperty(k, headers.optString(k, ""));
                }
            }
            // 报表类接口一页就是十几 MB 的 HTML（商品级库存单页 17MB），
            // 必须走 gzip（下面 readAll 会自动解压），否则手机上下载就要几十秒。
            if (!hasEncoding) c.setRequestProperty("Accept-Encoding", "gzip");

            String body = req.isNull("body") ? null : req.optString("body", null);
            if (body != null && body.length() > 0) {
                c.setDoOutput(true);
                OutputStream os = c.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.flush();
                os.close();
            }

            int status = c.getResponseCode();
            JSONObject hs = new JSONObject();
            Map<String, List<String>> fields = c.getHeaderFields();
            if (fields != null) {
                for (Map.Entry<String, List<String>> e : fields.entrySet()) {
                    String k = e.getKey();
                    List<String> v = e.getValue();
                    if (k == null || v == null || v.isEmpty()) continue;
                    String key = k.toLowerCase(Locale.US);
                    if (v.size() == 1) hs.put(key, v.get(0));
                    else hs.put(key, new JSONArray(v));
                }
            }
            InputStream in = (status >= 400 && c.getErrorStream() != null) ? c.getErrorStream() : c.getInputStream();
            JSONObject out = new JSONObject();
            out.put("status", status);
            out.put("headers", hs);
            out.put("body", readAll(in, c.getHeaderField("Content-Encoding")));
            return out.toString();
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream raw, String enc) throws Exception {
        if (raw == null) return "";
        InputStream in = raw;
        if (enc != null && enc.toLowerCase(Locale.US).contains("gzip")) in = new GZIPInputStream(raw);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } finally {
            try { in.close(); } catch (Exception ignored) { }
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        try { pool.shutdownNow(); } catch (Exception ignored) { }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
