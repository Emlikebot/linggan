package com.emlikebot.linggan;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Parcelable;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 相册里选中截屏 → 分享 → 灵感：把图片读出来先放在内存里，网页端调用 take() 取走（取走后就清空，不留档）。
 */
@CapacitorPlugin(name = "ShareIn")
public class ShareInPlugin extends Plugin {
    private static final int MAX = 10;
    private static final int RAW_LIMIT = 3 * 1024 * 1024;
    private static final List<JSObject> pending = new ArrayList<>();

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (collect(intent) > 0) {
            notifyListeners("shared", new JSObject(), true);
        }
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pending) {
            for (JSObject o : pending) arr.put(o);
            pending.clear();
        }
        JSObject r = new JSObject();
        r.put("images", arr);
        call.resolve(r);
    }

    @SuppressWarnings("deprecation")
    private int collect(Intent intent) {
        if (intent == null) return 0;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return 0;
        List<Uri> uris = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND.equals(action)) {
                Parcelable p = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (p instanceof Uri) uris.add((Uri) p);
            } else {
                ArrayList<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) for (Parcelable p : list) if (p instanceof Uri) uris.add((Uri) p);
            }
        } catch (Exception ignored) {}
        ClipData clip = intent.getClipData();
        if (uris.isEmpty() && clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        intent.setAction(Intent.ACTION_MAIN);   // 标记已处理，避免重复
        int n = 0;
        ContentResolver cr = getContext().getContentResolver();
        for (Uri u : uris) {
            if (n >= MAX) break;
            try {
                byte[] bytes = readAll(cr, u);
                String mime = cr.getType(u);
                if (mime == null || !mime.startsWith("image/")) mime = "image/jpeg";
                if (bytes.length > RAW_LIMIT) {           // 太大的长截屏先压一下再交给网页
                    byte[] small = shrink(bytes);
                    if (small != null) { bytes = small; mime = "image/jpeg"; }
                }
                JSObject o = new JSObject();
                o.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                o.put("mime", mime);
                synchronized (pending) { pending.add(o); }
                n++;
            } catch (Exception ignored) {}
        }
        return n;
    }

    private static byte[] readAll(ContentResolver cr, Uri u) throws Exception {
        try (InputStream in = cr.openInputStream(u)) {
            if (in == null) throw new Exception("no stream");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int r;
            while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            return out.toByteArray();
        }
    }

    private static byte[] shrink(byte[] bytes) {
        try {
            BitmapFactory.Options b = new BitmapFactory.Options();
            b.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, b);
            int sample = 1;
            while (b.outWidth / (sample * 2) >= 1080 || (long) b.outWidth * b.outHeight / ((long) sample * sample) > 24000000L) sample *= 2;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            o.inPreferredConfig = Bitmap.Config.RGB_565;
            Bitmap bm = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
            if (bm == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, 88, out);
            bm.recycle();
            return out.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }
}
