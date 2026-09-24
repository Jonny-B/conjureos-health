import { useEffect, useRef, useState } from "react";
import type { ChatImage } from "../bridge/ai";
import { CameraIcon } from "./icons";

/**
 * In-app live camera for the photo-capture fallbacks (nutrition label /
 * front-of-package). Streams the rear camera into a <video> and captures a
 * still to a canvas on the shutter tap — so the flow stays inside the app
 * instead of bouncing to the jarring full-screen OS camera that
 * `<input capture>` opens.
 *
 * Degrades gracefully: if getUserMedia is unavailable or denied (older
 * browsers, permissions off), it falls back to a file input so capture still
 * works everywhere. A "Choose from library" input is always offered for
 * desktop / when the user would rather pick an existing photo.
 */

type MediaType = ChatImage["mediaType"];
const ACCEPTED: ReadonlyArray<MediaType> = ["image/jpeg", "image/png", "image/webp"];

async function blobToChatImage(blob: Blob): Promise<ChatImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked base64 so large photos don't blow the call stack via apply().
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  const mediaType = (ACCEPTED.includes(blob.type as MediaType) ? blob.type : "image/jpeg") as MediaType;
  return { mediaType, data: btoa(binary) };
}

/**
 * Live camera viewfinder with a file-picker fallback. Emits the captured
 * frame as a base64 {@link ChatImage} ready for a vision call.
 *
 * Crops to exactly the region the user framed, not the raw sensor frame —
 * otherwise the model sees background outside the viewfinder and invents items
 * from it. Falls back to the file picker on desktop or when access is denied.
 */
export function CameraCapture({
  guide,
  onCapture,
}: {
  /** Short framing guidance shown under the viewfinder. */
  guide?: React.ReactNode;
  onCapture: (image: ChatImage, previewUrl: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const supported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const [status, setStatus] = useState<"starting" | "live" | "fallback">(
    supported ? "starting" : "fallback",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setStatus("live");
      } catch {
        // Denied / no camera / insecure context — fall back to the file picker.
        if (!cancelled) setStatus("fallback");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [supported]);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setBusy(true);
    try {
      const vW = video.videoWidth;
      const vH = video.videoHeight;
      // The viewfinder shows a `object-fit: cover` crop of the stage box, so the
      // sensor frame is WIDER/TALLER than what the user framed. Capture only the
      // visible region — otherwise the model sees the background outside the
      // frame and invents items from it (the reported "sees more than the UI
      // shows" bug). Fall back to the full frame if the box hasn't laid out.
      const dispW = video.clientWidth || vW;
      const dispH = video.clientHeight || vH;
      const dispAspect = dispW / dispH;
      const vAspect = vW / vH;
      let cropW = vW;
      let cropH = vH;
      let cropX = 0;
      let cropY = 0;
      if (vAspect > dispAspect) {
        cropW = Math.round(vH * dispAspect);
        cropX = Math.round((vW - cropW) / 2);
      } else if (vAspect < dispAspect) {
        cropH = Math.round(vW / dispAspect);
        cropY = Math.round((vH - cropH) / 2);
      }
      const canvas = document.createElement("canvas");
      canvas.width = cropW;
      canvas.height = cropH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setStatus("fallback");
        return;
      }
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/jpeg", 0.9),
      );
      if (!blob) return;
      const image = await blobToChatImage(blob);
      onCapture(image, URL.createObjectURL(blob));
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const image = await blobToChatImage(file);
      onCapture(image, URL.createObjectURL(file));
    } finally {
      setBusy(false);
    }
  };

  if (status === "fallback") {
    return (
      <div className="camera-capture fallback">
        <div className="camera-fallback-note">
          Live camera isn’t available here. Take or choose a photo instead.
        </div>
        <label className="btn primary block">
          <CameraIcon size={18} /> Take a photo
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="visually-hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </label>
        <label className="btn block">
          Choose from library
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="visually-hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </label>
        {guide && <div className="muted small">{guide}</div>}
      </div>
    );
  }

  return (
    <div className="camera-capture">
      <div className="camera-stage">
        <video ref={videoRef} className="camera-video" muted playsInline />
        <div className="camera-frame" aria-hidden />
        {status === "starting" && <div className="camera-hint">Starting camera…</div>}
        {guide && <div className="camera-guide">{guide}</div>}
        {/* Controls overlay the feed so the shutter stays reachable regardless
            of how tall the viewport / how much sits above the stage. */}
        <div className="camera-controls">
          <label className="camera-lib-btn" aria-label="Choose from library">
            Library
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="visually-hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>
          <button
            className="camera-shutter"
            aria-label="Capture photo"
            disabled={status !== "live" || busy}
            onClick={shoot}
          />
          <span className="camera-controls-spacer" aria-hidden />
        </div>
      </div>
    </div>
  );
}
