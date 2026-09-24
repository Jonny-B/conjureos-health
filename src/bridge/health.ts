/**
 * Health bridge — reads workouts + burned calories from the ConjureOS native
 * health broker (HealthKit / Health Connect via
 * `window.__conjureos.native.health`). Mirrors bridge/location.ts: it degrades
 * gracefully to empty when the native op is absent (web `npm run dev`, desktop,
 * or a mobile build without the health entitlement) so nothing hard-fails —
 * the diary just shows no wearable calories.
 *
 * One integration per OS aggregator captures EVERY wearable that writes to it:
 * an Apple Watch run lands in HealthKit automatically; Fitbit/Strava/Oura land
 * there too once the user enables their Apple Health / Health Connect sync.
 */

export interface WorkoutBurn {
  /** HealthKit/Health Connect activity string (e.g. "running", "37"). */
  workoutType: string;
  /** Epoch ms. */
  start: number;
  end: number;
  /** Active energy burned, kcal (rounded). */
  caloriesBurned: number;
  distanceMeters?: number;
  source?: string;
}

interface NativeHealthSample {
  kind?: string;
  workoutType?: string;
  start?: number;
  end?: number;
  activeEnergyKcal?: number;
  totalEnergyKcal?: number;
  distanceMeters?: number;
  source?: string;
}

interface NativeHealth {
  available: () => Promise<{ ok: boolean; platform: string }>;
  read: (o: {
    types: string[];
    since?: number;
    until?: number;
    limit?: number;
  }) => Promise<NativeHealthSample[]>;
}

function nativeHealth(): NativeHealth | undefined {
  const b = window.__conjureos as { native?: { health?: NativeHealth } } | undefined;
  return b?.native?.health;
}

/** Whether a real health source is wired (mobile broker + OS data available). */
export async function isHealthAvailable(): Promise<boolean> {
  const h = nativeHealth();
  if (!h) return false;
  try {
    const a = await h.available();
    return !!a?.ok;
  } catch {
    return false;
  }
}

/** Workouts (with burned calories) in [sinceMs, untilMs]. Empty if no source. */
export async function readWorkouts(
  sinceMs: number,
  untilMs: number = Date.now(),
): Promise<WorkoutBurn[]> {
  const h = nativeHealth();
  if (!h) return [];
  try {
    const samples = await h.read({
      types: ["workouts"],
      since: sinceMs,
      until: untilMs,
      limit: 200,
    });
    return (Array.isArray(samples) ? samples : [])
      .filter((s) => s && s.kind === "workout")
      .map((s) => ({
        workoutType: String(s.workoutType ?? "other"),
        start: Number(s.start ?? 0),
        end: Number(s.end ?? 0),
        caloriesBurned: Math.round(Number(s.activeEnergyKcal ?? s.totalEnergyKcal ?? 0)),
        distanceMeters:
          typeof s.distanceMeters === "number" ? s.distanceMeters : undefined,
        source: s.source,
      }))
      .filter((w) => w.end >= w.start);
  } catch {
    return [];
  }
}

/** Sum of workout calories burned on a local calendar day (YYYY-MM-DD). */
export async function readBurnedForDate(date: string): Promise<number> {
  // Local-day bounds (no trailing Z → parsed in the device's timezone).
  const start = new Date(`${date}T00:00:00`).getTime();
  const end = new Date(`${date}T23:59:59.999`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const workouts = await readWorkouts(start, end);
  return workouts.reduce((sum, w) => sum + (w.caloriesBurned || 0), 0);
}
