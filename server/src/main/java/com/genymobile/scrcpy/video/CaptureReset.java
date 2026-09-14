package com.genymobile.scrcpy.video;

import android.media.MediaCodec;
import android.os.Bundle;

import java.util.concurrent.atomic.AtomicBoolean;

public class CaptureReset implements SurfaceCapture.CaptureListener {

    private final AtomicBoolean reset = new AtomicBoolean();

    // Current instance of MediaCodec to "interrupt" on reset
    private MediaCodec runningMediaCodec;

    public boolean consumeReset() {
        return reset.getAndSet(false);
    }

    public synchronized void reset() {
        reset.set(true);
        if (runningMediaCodec != null) {
            try {
                runningMediaCodec.signalEndOfInputStream();
            } catch (IllegalStateException e) {
                // ignore
            }
        }
    }

    /**
     * Request a sync (IDR) frame on the running encoder without interrupting it.
     * <p>
     * Synchronized with {@link #setRunningMediaCodec(MediaCodec)} so the request
     * cannot race with codec stop/reset/release: a codec that is being torn down
     * either still accepts the request (harmless) or throws (caught below).
     *
     * @return {@code true} if the request was delivered to a running codec
     */
    public synchronized boolean requestSyncFrame() {
        MediaCodec codec = runningMediaCodec;
        if (codec == null) {
            return false;
        }
        try {
            Bundle params = new Bundle();
            params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            codec.setParameters(params);
            return true;
        } catch (IllegalStateException e) {
            return false;
        }
    }

    public synchronized void setRunningMediaCodec(MediaCodec runningMediaCodec) {
        this.runningMediaCodec = runningMediaCodec;
    }

    @Override
    public void onInvalidated() {
        reset();
    }
}
