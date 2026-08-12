package com.shanjing.example;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;

import com.lynx.tasm.LynxView;
import com.lynx.tasm.LynxViewBuilder;
import com.lynx.tasm.LynxViewClient;
import com.lynx.tasm.TemplateData;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

public final class MainActivity extends Activity {
    private static final String LOG_TAG = "MTCExample";
    private LynxView lynxView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        lynxView = new LynxViewBuilder().build(this);
        lynxView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        lynxView.addLynxViewClient(new LynxViewClient() {
            @Override
            public void onPageStart(String url) {
                Log.i(LOG_TAG, "MTC_EVENT page_opened");
            }

            @Override
            public void onFirstScreen() {
                Log.i(LOG_TAG, "MTC_EVENT page_ready");
            }

            @Override
            public void onLoadFailed(String message) {
                Log.e(LOG_TAG, "MTC_EVENT page_open_failed " + message);
            }
        });
        setContentView(lynxView);
        renderMainBundle();
    }

    private void renderMainBundle() {
        try (InputStream input = getAssets().open("main.bundle")) {
            lynxView.renderTemplate(readBytes(input), TemplateData.empty());
        } catch (IOException error) {
            Log.e(LOG_TAG, "MTC_EVENT page_open_failed " + error.getMessage(), error);
        }
    }

    private static byte[] readBytes(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) >= 0) {
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    @Override
    protected void onDestroy() {
        if (lynxView != null) {
            lynxView.destroy();
        }
        super.onDestroy();
    }
}

