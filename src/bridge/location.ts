/**
 * Location bridge — mirrors bridge/ai.ts. Cardio tracking calls THIS, never
 * `navigator` directly, so W7 can swap in the native mobile op (a one-shot
 * `location.getCurrent` polled here) without touching the player. On the web
 * shell the app iframe already receives `allow="geolocation"`, so
 * `watchPosition` works today with no ConjureOS bridge.
 */

export interface LocationSample {
  lat: number;
  lon: number;
  /** Epoch ms. */
  t: number;
  /** Metres, when the source reports it. */
  accuracy?: number;
}

type NativeLocation = () => Promise<{ lat: number; lon: number; t?: number; accuracy?: number }>;

function nativeLocation(): NativeLocation | undefined {
  const b = window.__conjureos as { native?: { location?: NativeLocation } } | undefined;
  return b?.native?.location;
}

/** Whether GPS can be read at all — via the native op or the browser's
 *  geolocation API. Gate the cardio distance tracker on this. */
export function isLocationAvailable(): boolean {
  if (nativeLocation()) return true;
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

/**
 * Stream location until the returned unsubscribe is called. Prefers the native
 * op (polled ~every 2.5s — the one-shot bridge has no streaming channel, by
 * design); else the browser's continuous `watchPosition`.
 */
export function watchLocation(
  onSample: (s: LocationSample) => void,
  onError?: (message: string) => void,
): () => void {
  const native = nativeLocation();
  if (native) {
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      try {
        const p = await native();
        if (alive && p) onSample({ lat: p.lat, lon: p.lon, t: p.t ?? Date.now(), accuracy: p.accuracy });
      } catch (e) {
        onError?.(e instanceof Error ? e.message : String(e));
      }
    };
    const id = window.setInterval(poll, 2500);
    void poll();
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }

  if (typeof navigator !== "undefined" && navigator.geolocation) {
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        onSample({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          t: pos.timestamp,
          accuracy: pos.coords.accuracy ?? undefined,
        }),
      (err) => onError?.(err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }

  onError?.("No location source available");
  return () => {};
}

/** Great-circle distance between two samples, in metres. */
export function haversineMeters(a: LocationSample, b: LocationSample): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
