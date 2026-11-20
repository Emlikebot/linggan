"""CI 用：给安卓工程加上「接收分享的图片」并换上自己的 MainActivity。python3 scripts/patch-android.py"""
import os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "android", "app", "src", "main")
M = os.path.join(APP, "AndroidManifest.xml")
xml = open(M, encoding="utf-8").read()

FILTERS = """
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
"""
if "android.intent.action.SEND_MULTIPLE" not in xml:
    # 插在主 Activity 的 LAUNCHER intent-filter 后面
    m = re.search(r'(<category android:name="android.intent.category.LAUNCHER"\s*/>\s*</intent-filter>)', xml)
    if not m:
        sys.exit("找不到 LAUNCHER intent-filter：\n" + xml)
    xml = xml[:m.end()] + FILTERS + xml[m.end():]
open(M, "w", encoding="utf-8").write(xml)

java = os.path.join(APP, "java", "com", "emlikebot", "linggan")
os.makedirs(java, exist_ok=True)
for f in ("MainActivity.java", "ShareInPlugin.java"):
    shutil.copy(os.path.join(ROOT, "android-native", f), os.path.join(java, f))
print(open(M, encoding="utf-8").read())
print("patched:", os.listdir(java))
