package com.emlikebot.linggan;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareInPlugin.class);   // 接收相册「分享」进来的截屏
        super.onCreate(savedInstanceState);
    }
}
