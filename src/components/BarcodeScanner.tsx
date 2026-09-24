import { useEffect, useRef, useState } from "react";
import { isScanSupported, scanFromVideo } from "../features/barcode";
import { CameraIcon, FlashlightIcon, KeyboardIcon } from "./icons";

/**
 * Immersive in-page barcode scanner. Streams the rear camera into a <video>,
 * overlays a corner-bracket reticle + sweeping scan line, and polls
 * `BarcodeDetector` until a code is read. Deliberately stays embedded in the
 * Add screen (never a full-screen OS camera takeover) so the app chrome and
 * mode tabs remain visible — matching the reference design.
 *
 * Floating controls: a flashlight toggle (when the camera exposes a torch),
 * plus optional "enter barcode" / "snap a photo" shortcuts wired by the parent
 * so the whole scan experience — barcode + photo fallback — lives on one
 * surface.
 *
 * Renders a clear unsupported/denied state so the parent can offer manual
 * entry (iOS Safari / Firefox have no native BarcodeDetector; the polyfill in
 * main.tsx covers most, but camera denial still needs a fallback).
 */

export function BarcodeScanner({
  onDetected,
  onError,
  onEnterBarcode,
  onSnapPhoto,
}: {
  onDetected: (barcode: string) => void;
  onError?: (message: string) => void;
  /** Show a keyboard shortcut that reveals manual barcode entry. */
  onEnterBarcode?: () => void;
  /** Show a camera shortcut that jumps to the photo-capture fallback. */
  onSnapPhoto?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [status, setStatus] = useState<"starting" | "scanning" | "unsupported" | "error">(
    isScanSupported() ? "starting" : "unsupported",
  );
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // The frozen frame from the instant of detection. Set BEFORE the parent is
  // told, so the camera visibly stops the moment the code is read rather than
  // when the (network) lookup finishes.
  const [snapshot, setSnapshot] = useState<string | null>(null);

  useEffect(() => {
    if (!isScanSupported()) return;
    const controller = new AbortController();
    let stream: MediaStream | null = null;

    /**
     * Turn the live feed into a still, the instant a code is read: grab the
     * current frame to a data URL, swap it in for the <video>, and release the
     * camera. Releasing matters — it drops the capture indicator and the torch
     * right away instead of holding the camera open for the whole lookup.
     *
     * Best-effort: if the frame can't be grabbed (zero-sized video, a tainted
     * canvas) we still pause and stop the stream, so the feed never keeps
     * running after a detection.
     */
    const freeze = (video: HTMLVideoElement) => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w > 0 && h > 0) {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
          setSnapshot(canvas.toDataURL("image/jpeg", 0.85));
        }
      } catch {
        /* no still — the pause + stopped stream below still freeze the view */
      }
      video.pause();
      stream?.getTracks().forEach((t) => t.stop());
      trackRef.current = null;
      setHasTorch(false);
    };

    // Warm the WASM engine in parallel with getUserMedia. On WebKit the
    // polyfill lazy-fetches a ~1 MiB wasm blob on first detect(); kicking it
    // off here hides the 200 to 800 ms stall behind the camera-permission
    // dialog. Errors are intentionally swallowed: this is best-effort.
    try {
      const warmCanvas = document.createElement("canvas");
      warmCanvas.width = 1;
      warmCanvas.height = 1;
      const Ctor = (globalThis as { BarcodeDetector?: new () => { detect: (s: CanvasImageSource) => Promise<unknown> } }).BarcodeDetector;
      if (Ctor) new Ctor().detect(warmCanvas).catch(() => {});
    } catch {
      /* best-effort warm-up */
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        const video = videoRef.current;
        if (!video || controller.signal.aborted) return;
        video.srcObject = stream;
        await video.play();
        setStatus("scanning");

        // Detect a torch so we can offer a flashlight toggle for dim aisles.
        const track = stream.getVideoTracks()[0];
        if (track) {
          trackRef.current = track;
          const caps = track.getCapabilities?.() as
            | (MediaTrackCapabilities & { torch?: boolean })
            | undefined;
          if (caps?.torch) setHasTorch(true);
        }

        const code = await scanFromVideo(video, { signal: controller.signal, timeoutMs: 60_000 });
        if (code && !controller.signal.aborted) {
          // Freeze FIRST. The parent's onDetected kicks off a barcode lookup
          // that can take seconds over the network; leaving the feed live and
          // the scan line sweeping through it reads as "still scanning" and
          // invites the user to re-aim at a code we already have.
          freeze(video);
          onDetected(code);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setStatus("error");
          onError?.(err instanceof Error ? err.message : "Camera unavailable");
        }
      }
    })();

    return () => {
      controller.abort();
      stream?.getTracks().forEach((t) => t.stop());
      trackRef.current = null;
    };
    // onDetected/onError are stable enough for this one-shot scan session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      // Some devices report torch support but reject the constraint — hide it.
      setHasTorch(false);
    }
  };

  if (status === "unsupported" || status === "error") {
    return (
      <div className="scanner-fallback">
        <div>
          {status === "unsupported"
            ? "Live scanning isn’t supported in this browser."
            : "Couldn’t open the camera."}
        </div>
        <div className="scanner-fallback-actions">
          {onEnterBarcode && (
            <button className="btn" onClick={onEnterBarcode}>
              <KeyboardIcon size={16} /> Enter barcode
            </button>
          )}
          {onSnapPhoto && (
            <button className="btn primary" onClick={onSnapPhoto}>
              <CameraIcon size={16} /> Snap a photo
            </button>
          )}
        </div>
      </div>
    );
  }

  const captured = snapshot !== null;

  return (
    <div className={`scanner${captured ? " captured" : ""}`}>
      {captured ? (
        <img className="scanner-video scanner-still" src={snapshot} alt="" aria-hidden />
      ) : (
        <video ref={videoRef} className="scanner-video" muted playsInline />
      )}
      {captured && <div className="scanner-flash" aria-hidden />}
      <div className="scanner-overlay" aria-hidden>
        <div className="scanner-reticle">
          <span className="reticle-corner tl" />
          <span className="reticle-corner tr" />
          <span className="reticle-corner bl" />
          <span className="reticle-corner br" />
          {/* The sweeping line means "still looking" — drop it the moment we
              have a code, even though the parent's lookup is still running. */}
          {!captured && <span className="scanner-line" />}
        </div>
      </div>
      <div className="scanner-guide">
        {captured
          ? "Barcode captured"
          : status === "starting"
            ? "Starting camera…"
            : "Line up the barcode. Hold ~6″ away, avoid glare and shadows."}
      </div>
      {/* Once captured the camera is released, so its controls are meaningless. */}
      {!captured && (
        <div className="scanner-controls">
          {onEnterBarcode && (
            <button className="scanner-ctl" aria-label="Enter barcode by hand" onClick={onEnterBarcode}>
              <KeyboardIcon size={20} />
            </button>
          )}
          {hasTorch && (
            <button
              className={`scanner-ctl${torchOn ? " on" : ""}`}
              aria-label={torchOn ? "Turn flashlight off" : "Turn flashlight on"}
              aria-pressed={torchOn}
              onClick={toggleTorch}
            >
              <FlashlightIcon size={20} />
            </button>
          )}
          {onSnapPhoto && (
            <button className="scanner-ctl" aria-label="Snap a photo instead" onClick={onSnapPhoto}>
              <CameraIcon size={20} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
