import { useCallback, useEffect, useRef, useState } from "react";
import type { CardioActual } from "../../types";
import { haversineMeters, isLocationAvailable, watchLocation, type LocationSample } from "../../bridge/location";

/** Live state of a GPS-tracked cardio session, recomputed on every fix. */
export interface CardioTrackState {
  distanceKm: number;
  elapsedSec: number;
  /** Seconds per km, or null until enough distance to be meaningful. */
  paceSecPerKm: number | null;
  /** Completed-km split times, seconds. */
  splits: number[];
  running: boolean;
  autoPaused: boolean;
  /** True once at least one GPS fix has arrived. */
  gps: boolean;
}

const MIN_MOVE_M = 4; // ignore sub-jitter movement
const MAX_JUMP_M = 120; // ignore a single bad fix that teleports
const AUTOPAUSE_MS = 10000; // no movement this long → pause the clock

const INITIAL: CardioTrackState = {
  distanceKm: 0,
  elapsedSec: 0,
  paceSecPerKm: null,
  splits: [],
  running: false,
  autoPaused: false,
  gps: false,
};

/**
 * GPS run/bike tracker. Distance via haversine over the position stream; elapsed
 * from `Date.now()` deltas (not tick counts, so backgrounding doesn't inflate
 * time); per-km splits; auto-pause when movement stalls; best-effort wakeLock.
 */
export function useGpsTracker() {
  const available = isLocationAvailable();
  const [state, setState] = useState<CardioTrackState>(INITIAL);

  const runningRef = useRef(false);
  const autoPausedRef = useRef(false);
  const distMRef = useRef(0);
  const elapsedMsRef = useRef(0);
  const lastTickRef = useRef(0);
  const lastSampleRef = useRef<LocationSample | null>(null);
  const lastMoveRef = useRef(0);
  const nextSplitKmRef = useRef(1);
  const lastSplitElapsedRef = useRef(0);
  const splitsRef = useRef<number[]>([]);
  const trackRef = useRef<LocationSample[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);
  const wakeRef = useRef<{ release: () => void } | null>(null);

  const publish = useCallback(() => {
    const km = distMRef.current / 1000;
    const sec = Math.round(elapsedMsRef.current / 1000);
    setState({
      distanceKm: km,
      elapsedSec: sec,
      paceSecPerKm: km > 0.05 ? sec / km : null,
      splits: [...splitsRef.current],
      running: runningRef.current,
      autoPaused: autoPausedRef.current,
      gps: trackRef.current.length > 0,
    });
  }, []);

  const onSample = useCallback(
    (s: LocationSample) => {
      trackRef.current.push(s);
      const last = lastSampleRef.current;
      lastSampleRef.current = s;
      if (!runningRef.current) {
        publish();
        return;
      }
      if (last) {
        const d = haversineMeters(last, s);
        const threshold = Math.max(MIN_MOVE_M, (s.accuracy ?? 20) * 0.5);
        if (d >= threshold && d < MAX_JUMP_M) {
          distMRef.current += d;
          lastMoveRef.current = Date.now();
          autoPausedRef.current = false;
          const km = distMRef.current / 1000;
          while (km >= nextSplitKmRef.current) {
            const sec = Math.round(elapsedMsRef.current / 1000);
            splitsRef.current.push(sec - lastSplitElapsedRef.current);
            lastSplitElapsedRef.current = sec;
            nextSplitKmRef.current += 1;
          }
        }
      } else {
        lastMoveRef.current = Date.now();
      }
      publish();
    },
    [publish],
  );

  // 1 Hz clock: accrue elapsed by wall-clock delta, auto-pause on stall.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!runningRef.current) {
        lastTickRef.current = Date.now();
        return;
      }
      const now = Date.now();
      if (lastMoveRef.current && now - lastMoveRef.current > AUTOPAUSE_MS) autoPausedRef.current = true;
      if (!autoPausedRef.current) {
        const dt = lastTickRef.current ? now - lastTickRef.current : 0;
        elapsedMsRef.current += Math.min(Math.max(dt, 0), 2000); // clamp big/negative gaps
      }
      lastTickRef.current = now;
      publish();
    }, 1000);
    return () => window.clearInterval(id);
  }, [publish]);

  const requestWake = () => {
    try {
      const wl = (navigator as { wakeLock?: { request: (t: string) => Promise<{ release: () => void }> } }).wakeLock;
      wl?.request("screen").then((s) => (wakeRef.current = s)).catch(() => {});
    } catch {
      /* best-effort */
    }
  };

  const start = useCallback(() => {
    runningRef.current = true;
    lastTickRef.current = Date.now();
    lastMoveRef.current = Date.now();
    if (!unsubRef.current) unsubRef.current = watchLocation(onSample);
    requestWake();
    publish();
  }, [onSample, publish]);

  const pause = useCallback(() => {
    runningRef.current = false;
    publish();
  }, [publish]);

  const resume = useCallback(() => {
    runningRef.current = true;
    autoPausedRef.current = false;
    lastTickRef.current = Date.now();
    lastMoveRef.current = Date.now();
    publish();
  }, [publish]);

  const stop = useCallback((): CardioActual => {
    runningRef.current = false;
    unsubRef.current?.();
    unsubRef.current = null;
    wakeRef.current?.release?.();
    wakeRef.current = null;
    const km = distMRef.current / 1000;
    const sec = Math.round(elapsedMsRef.current / 1000);
    publish();
    return {
      distanceKm: Math.round(km * 1000) / 1000,
      durationSec: sec,
      avgPaceSecPerKm: km > 0.05 ? Math.round(sec / km) : undefined,
      source: "gps",
      splits: [...splitsRef.current],
      track: trackRef.current.map((t) => ({ lat: t.lat, lon: t.lon, t: t.t, accuracy: t.accuracy })),
    };
  }, [publish]);

  useEffect(
    () => () => {
      unsubRef.current?.();
      wakeRef.current?.release?.();
    },
    [],
  );

  return { available, state, start, pause, resume, stop };
}
