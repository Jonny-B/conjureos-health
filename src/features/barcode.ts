/**
 * Barcode scanning via the native `BarcodeDetector` API.
 *
 * Supported on Android Chrome and Chromium desktop; NOT on iOS Safari or
 * Firefox as of writing. Callers must handle the unsupported case by falling
 * back to manual barcode entry (the FoodSearch screen does). We deliberately
 * avoid bundling a WASM decoder (ZXing/quagga) in v1 to keep the app small;
 * that's the obvious upgrade if iOS camera scanning becomes a priority.
 */

interface DetectedBarcode {
  rawValue: string;
  format: string;
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"];

function ctor(): BarcodeDetectorCtor | null {
  const c = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof c === "function" ? c : null;
}

/** Whether the platform can decode barcodes natively. False on older
 *  browsers, where the UI offers manual entry instead of the scanner. */
export function isScanSupported(): boolean {
  return ctor() !== null;
}

/**
 * Continuously scan a live <video> element until a barcode is read, the
 * AbortSignal fires, or `timeoutMs` elapses. Resolves with the raw barcode
 * string, or null on timeout/abort. The caller owns the video stream lifecycle.
 */
export async function scanFromVideo(
  video: HTMLVideoElement,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const C = ctor();
  if (!C) return null;
  const detector = new C({ formats: FORMATS });
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return null;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      try {
        const found = await detector.detect(video);
        const hit = found.find((b) => /^\d{6,14}$/.test(b.rawValue.replace(/\D/g, "")));
        if (hit) return hit.rawValue.replace(/\D/g, "");
      } catch {
        // Transient detect failures (frame not ready) — keep polling.
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Validate a manually-typed barcode (EAN/UPC are 8–14 digits). */
export function isValidBarcode(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14;
}
