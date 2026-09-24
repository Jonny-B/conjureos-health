/**
 * Domain model shared across Conjure Fitness.
 *
 * Kept narrow and additive — these shapes are persisted (to Supabase rows and
 * to the VFS mock store), so adding optional fields later is cheap but
 * renaming/removing them is a migration. Macros are always grams; energy is
 * always kilocalories ("calories" in US food-label parlance).
 */

// ── Nutrition primitives ─────────────────────────────────────────────

/** The four headline numbers Conjure Fitness tracks against goals. */
export interface Macros {
  /** Energy in kilocalories. */
  calories: number;
  /** Grams of protein. */
  protein: number;
  /** Grams of carbohydrate. */
  carbs: number;
  /** Grams of fat. */
  fat: number;
}

/** Optional micronutrients a food source may provide; all per serving. */
export interface Micros {
  fiber?: number;
  sugar?: number;
  addedSugar?: number;
  saturatedFat?: number;
  transFat?: number;
  cholesterolMg?: number;
  /** Sodium in milligrams. */
  sodium?: number;
  potassiumMg?: number;
  calciumMg?: number;
  ironMg?: number;
  vitaminAIu?: number;
  vitaminCMg?: number;
  vitaminDIu?: number;
  alcoholG?: number;
  caffeineMg?: number;
}

/** Where a FoodItem came from + the trust signals attached to it. */
export interface FoodProvenance {
  /** Matches the DB source column: our_db / off_backfill / ai_label / ai_front / user_manual. */
  sourceTag: string;
  aiConfidence?: number;
  isCanonical?: boolean;
  license?: string;
  attributionText?: string;
  warningNote?: string;
}

/** The additive identity for macro sums — a fresh accumulator. */
export const ZERO_MACROS: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0 };

// ── Foods ────────────────────────────────────────────────────────────

/** Where a food's numbers came from. Drives attribution and how much the UI
 *  trusts them: `custom` includes unreviewed AI estimates. */
export type FoodSource = "openfoodfacts" | "usda" | "custom" | "recipe" | "conjure_health";

/**
 * A food the user can log. Nutrition is expressed **per one serving** of
 * `servingSize`. The diary stores a snapshot of this so edits to the source
 * database (or a deleted recipe) never silently rewrite history.
 */
export interface FoodItem {
  /** Stable id within `source` (barcode, USDA fdcId, recipe slug, or a uuid). */
  id: string;
  source: FoodSource;
  /** Display name, e.g. "Greek Yogurt, plain". */
  name: string;
  /** Brand / manufacturer when known (branded barcode items). */
  brand?: string;
  /** EAN/UPC barcode when the item came from a scan. */
  barcode?: string;
  /** Nutrition for exactly one `servingSize`. */
  perServing: Macros;
  micros?: Micros;
  /** Human label for one serving, e.g. "1 cup (240 g)" or "100 g". */
  servingSize: string;
  /** Grams in one serving when known, so we can offer gram-based quantities. */
  servingGrams?: number;
  provenance?: FoodProvenance;
}

// ── Diary ────────────────────────────────────────────────────────────

/** The four diary buckets a food can be logged into. */
export type MealType = "breakfast" | "lunch" | "dinner" | "snacks";

/** Meals in the order the diary lists them. */
export const MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snacks"];

/** Display names for each meal slot. */
export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snacks: "Snacks",
};

/**
 * One logged food in the diary. Carries a full snapshot of the food so the
 * entry is self-contained and stable. `quantity` is a multiplier on
 * `food.perServing` (1 = one serving, 0.5 = half, 2 = two servings).
 */
export interface DiaryEntry {
  id: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  meal: MealType;
  food: FoodItem;
  quantity: number;
  /** ISO timestamp the entry was created. */
  loggedAt: string;
  /**
   * Keep this entry out of the meal's Quick add shortcuts.
   *
   * Set when the user logs something they don't want re-suggested — a cheese
   * board that came back as twenty items would otherwise fill Quick add for a
   * week and bury the things they eat regularly. The entry stays in the diary
   * and in the journal, and counts towards the day exactly as normal; it is
   * only hidden from the one-tap re-log list.
   *
   * Named for Quick add rather than "history" on purpose: the Journal tab is
   * the history, and having two different things by that name confused the
   * first person who used it.
   */
  excludeFromQuickAdd?: boolean;
}

// ── Sleep, water & symptoms ──────────────────────────────────────────

/**
 * One night's sleep.
 *
 * Both ends are full ISO timestamps rather than clock strings, because the
 * whole difficulty here is that a night crosses a date boundary: "23:10 to
 * 06:40" and "00:40 to 08:15" are both ordinary nights, and only absolute
 * instants can tell them apart from a typo. `date` is the WAKE date — the day
 * the night belongs to in every sleep tracker and in how people talk ("I
 * slept badly last night"), so Monday's row shows the sleep that ENDED Monday
 * morning. See features/sleep.
 */
export interface SleepEntry {
  id: string;
  /** The date this night is filed under: the local date of `wakeAt`. */
  date: string;
  /** When they went to bed, ISO with offset. May be the previous calendar day. */
  bedAt: string;
  /** When they got up, ISO with offset. Always after `bedAt`. */
  wakeAt: string;
  /** Self-rated rest, 1 (awful) to 5 (great). Optional. */
  quality?: number;
  note?: string;
}

/** A drink. Stored in millilitres regardless of the user's display units, so
 *  switching units never rewrites history. */
export interface WaterEntry {
  id: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** ISO timestamp it was logged — this is where it lands on the timeline. */
  loggedAt: string;
  ml: number;
}

/**
 * Something the user felt and wanted on the record — a headache, heartburn,
 * anything they type. Deliberately free-form with a suggested bank rather than
 * a fixed enum: the point is to catch whatever THEY notice, and a closed list
 * would quietly discard the interesting cases.
 */
export interface SymptomEntry {
  id: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** ISO timestamp it was logged — this is where it lands on the timeline. */
  loggedAt: string;
  /** What it was, e.g. "Headache". Free text; the bank is only a shortcut. */
  label: string;
  /** How bad, 1 (barely) to 5 (severe). Optional. */
  severity?: number;
  note?: string;
}

/** The common ones, offered as one-tap chips. Not exhaustive and not a
 *  constraint — anything typed is stored verbatim. */
export const COMMON_SYMPTOMS: readonly string[] = [
  "Headache",
  "Heartburn",
  "Bloating",
  "Nausea",
  "Vomiting",
  "Diarrhea",
  "Constipation",
  "Low appetite",
  "Fatigue",
  "Cramps",
  "Dizziness",
  "Congestion",
  "Joint pain",
  "Low mood",
];

// ── Profile & goals ──────────────────────────────────────────────────

/** Biological sex for the Mifflin calorie estimate. `not_shared` = undisclosed;
 *  it's treated like the safe (higher) default floor and the male BMR constant. */
export type Sex = "male" | "female" | "not_shared";

/** Day-to-day activity outside deliberate training. Scales BMR into TDEE
 *  (see `tdee`) and seeds the wizard's suggested training days per week. */
export type ActivityLevel =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active";

/** Which way the user wants their weight to move. Derived from goal weight
 *  vs current weight, and sets the calorie deficit/surplus. */
export type GoalDirection = "lose" | "maintain" | "gain";

/** How much training background the user has — tunes workout difficulty. */
export type ExperienceLevel = "beginner" | "intermediate" | "advanced";

/**
 * The user's body + activity inputs. Used to derive recommended goals via
 * Mifflin-St Jeor; the user can always override the resulting numbers.
 */
export interface Profile {
  sex: Sex;
  /** Years. */
  age: number;
  /** Centimetres. */
  heightCm: number;
  /** Current weight in kilograms (the goal calc input; weight history is
   *  tracked separately in WeightEntry). */
  weightKg: number;
  activityLevel: ActivityLevel;
  direction: GoalDirection;
  /** Training background — tunes generated workout difficulty. */
  experienceLevel?: ExperienceLevel;
  /** Target weight in kilograms (for lose/gain). */
  goalWeightKg?: number;
  /** Display unit preference. Storage is always metric. */
  units: "metric" | "imperial";
  /** Guided-setup progress. Absent ⇒ setup never started. Additive; rides
   *  saveProfile, so it works on both the mock and Supabase backends. */
  setup?: ProfileSetup;
  /** Agreement to send journal data to the AI for pattern analysis. Absent
   *  ⇒ never asked, and nothing may be sent. */
  aiJournalConsent?: AiJournalConsent;
}

/**
 * The user's recorded agreement to send journal data off-device for AI
 * analysis.
 *
 * Kept as a stored RECORD rather than inferred from a setting, because it is
 * the app's authorization for a disclosure of health data: what they agreed
 * to, and when. Absent means never asked — which must block the disclosure,
 * not default to allowing it.
 */
export interface AiJournalConsent {
  /** ISO timestamp of the accept. */
  acceptedAt: string;
  /** Which disclosure wording they saw. A reworded disclosure re-asks rather
   *  than silently inheriting agreement to different text. */
  version: number;
  /** Opt-in, separate from the main accept: include the free-text notes
   *  attached to symptoms. Off unless they said yes. */
  includeNotes: boolean;
}

/** Which steps of the guided profile/goals setup the user has completed. */
export interface ProfileSetup {
  completedSteps: string[];
}

/**
 * Daily targets. Macro grams are the source of truth; calorie goal should
 * equal 4·protein + 4·carbs + 9·fat but is stored explicitly so a user can
 * pin calories and let macros float (or vice versa).
 */
export interface Goals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Fallback daily targets before a plan exists (or for a workouts-only plan
 *  that tracks no food). Deliberately middle-of-the-road, not personalized. */
export const DEFAULT_GOALS: Goals = {
  calories: 2000,
  protein: 120,
  carbs: 200,
  fat: 67,
};

/** Fallback body/activity inputs when none have been entered yet. Shared by the
 *  settings editor and the plan service's profile reconciliation. */
export const DEFAULT_PROFILE: Profile = {
  sex: "female",
  age: 30,
  heightCm: 170,
  weightKg: 70,
  activityLevel: "moderate",
  direction: "maintain",
  units: "metric",
};

// ── Weight (scaffolded slice) ────────────────────────────────────────

/** One weigh-in. At most one per calendar day — a second write for the same
 *  date replaces the first rather than appending. */
export interface WeightEntry {
  /** YYYY-MM-DD. One canonical entry per day (last write wins). */
  date: string;
  weightKg: number;
}

// ── Fitness / workouts (scaffolded slice) ────────────────────────────

/**
 * Attribution for trainer/coach-authored content. Forward-compatible hook for
 * the planned "fitness coach" ConjureOS user type: licensed trainers author
 * workouts/programs that import into a user's fitness app and display with the
 * coach's name, photo, and credit.
 *
 * Optional everywhere today — built-in seeds and user-made content omit it and
 * nothing depends on it yet. Kept here so the eventual coach feature is purely
 * additive (no migration of the Workout shape). See the GitHub "coach" epic.
 */
export interface CoachProfile {
  /** Stable coach id — a ConjureOS user id once coach accounts exist. */
  id: string;
  /** Display name for the "designed by" credit. */
  name: string;
  /** Headshot/avatar URL or data URL. */
  photoUrl?: string;
  /** Short credential line, e.g. "NASM-CPT · 8 yrs". */
  credentials?: string;
  /** One-paragraph bio for a future coach profile page. */
  bio?: string;
  /** Optional external link (site / booking). */
  link?: string;
  /** True once licensed-trainer status has been verified. */
  verified?: boolean;
}

/** Where a workout came from. Treated as "built-in" when omitted. */
export type WorkoutOrigin = "built-in" | "coach" | "user";

/** One prescribed set. Exactly one of `reps`/`durationSec` is non-null:
 *  reps for countable work, durationSec for holds and timed intervals. */
export interface ExerciseSet {
  /** Target reps, or null for a timed set. */
  reps: number | null;
  /** Target seconds for a timed/hold set, or null for a rep set. */
  durationSec: number | null;
  /** Rest after this set, seconds. */
  restSec: number;
  /** Optional target weight in kilograms. */
  weightKg?: number;
}

/** One movement within a workout, plus its prescribed sets. */
export interface Exercise {
  id: string;
  name: string;
  sets: ExerciseSet[];
  /** Optional cue shown during the set. */
  notes?: string;
  /** Inline explainer override; otherwise resolved by key (see ExerciseExplainer). */
  explainer?: ExerciseExplainer;
}

/**
 * How-to / muscles-worked / useful-data for an exercise. Resolved by
 * `exerciseKey` from a layered source: the user's own VFS note first, then a
 * trainer/DB entry (when trainers exist), then an AI-generated + cached one.
 */
export interface ExerciseExplainer {
  exerciseKey: string;
  /** Step-by-step how-to. */
  howTo: string;
  /** Primary muscles worked. */
  worksMuscles?: string[];
  /** Tips, typical ranges, common mistakes. */
  usefulData?: string;
  source: "user" | "coach" | "ai";
  /** Set when source === "coach". */
  author?: CoachProfile;
  /** ISO timestamp — set for AI-generated entries so the cache can age out. */
  cachedAt?: string;
}

/** Workout modality. Absent ⇒ "strength" (the guided step player); cardio
 *  kinds route to the distance tracker instead of buildSteps. */
export type WorkoutKind = "strength" | "run" | "bike";

/** A complete workout: a named, ordered list of exercises the player runs. */
export interface Workout {
  id: string;
  name: string;
  /** Short pitch / focus, e.g. "Full-body, 20 min, no equipment". */
  summary?: string;
  /** Longer overview shown on the pre-workout splash — what it trains, who
   *  it's for, how to approach it. Falls back to `summary` when absent. */
  description?: string;
  exercises: Exercise[];
  /** Modality — absent means strength (back-compat with the built-in seeds). */
  kind?: WorkoutKind;
  /** For cardio kinds: an optional distance/time goal shown during the run. */
  cardioTarget?: { distanceKm?: number; durationSec?: number };
  /** Provenance — defaults to built-in when omitted. */
  origin?: WorkoutOrigin;
  /** Coach credit, present when origin === "coach". Additive — see CoachProfile. */
  author?: CoachProfile;
}

// ── v2: plans, check-off, coached sessions ───────────────────────────
//
// These persist as VFS app data in the on-device store on every backend
// (owner call, DECISIONS 2026-06-24), with no Supabase tables. All shapes are additive and
// self-contained so Phase 9 platform sync can back the JSON up as-is.

/**
 * How a plan is oriented. `logging_only` is the safety fallback: the intake
 * gate (under-18 / pregnant / cardiac) forces it, hiding the workout surface.
 */
export type PlanMode = "eat_better" | "get_fit" | "both" | "logging_only";

/** Coarse age bands — we never store an exact DOB for the safety intake. */
export type AgeBand = "under_18" | "18_39" | "40_59" | "60_plus";

/**
 * The short safety questionnaire captured at wizard step 2. Drives the intake
 * gate (layer 1) and the injury-region exclusion list (layer 2). Deliberately
 * coarse: bands and booleans, no medical detail.
 */
export interface SafetyIntake {
  ageBand: AgeBand;
  /** Currently pregnant or postpartum — forces logging_only. */
  pregnant: boolean;
  /** Any cardiac condition / doctor advisory — forces logging_only. */
  cardiacFlag: boolean;
  /** Injury regions to exclude movements for (keys into the exclusion map). */
  injuries: string[];
  /** Self-reported baseline, reuses the profile scale. */
  activityLevel: ActivityLevel;
}

/**
 * One trackable item in a plan — the unit a DailyCheckoff ticks off. Ids are
 * stable within a plan so check-off history references survive a reload.
 */
export interface PlanGoal {
  id: string;
  /** User-facing line, e.g. "Hit 120 g protein" or "20-min workout". */
  label: string;
  kind: "nutrition" | "workout" | "habit";
  /** Optional machine detail (target grams, workout id) for future automation. */
  detail?: string;
}

/**
 * Liability acknowledgement. The timestamp is the audit record for the
 * first-run "I understand" acceptance; lives on the plan (`plan.json.liability`).
 */
export interface LiabilityAck {
  acknowledged: boolean;
  /** ISO timestamp of acceptance. */
  acceptedAt: string;
  /** App version at acceptance, for audit. */
  appVersion?: string;
}

/**
 * What a benchmark measures. Determines how a finished session's result maps to
 * a single comparable number, and (with `lowerIsBetter`) which direction counts
 * as improvement.
 */
export type BenchmarkMetric = "reps" | "weightKg" | "durationSec" | "distanceKm";

/** One measurement of a benchmark over time. */
export interface BenchmarkPoint {
  value: number;
  /** ISO timestamp. */
  at: string;
  /** The WorkoutSession this measurement came from. */
  sessionId?: string;
}

/**
 * A measurable baseline the plan is built to improve — the heart of the
 * adaptive loop. `baseline` is null until the benchmark workout is first
 * completed; that completion sets `baseline` and pushes the first `history`
 * point. `target` is the value to reach. For most metrics higher is better;
 * a timed effort over a fixed distance sets `lowerIsBetter`.
 */
export interface Benchmark {
  id: string;
  /** Exercise this benchmark tracks — normalized join key to sessions. */
  exerciseKey: string;
  /** Display name of the tracked effort. */
  name: string;
  metric: BenchmarkMetric;
  /** First measured value; null until the benchmark session finishes. */
  baseline: number | null;
  /** The value to reach (improvement goal). */
  target: number;
  /** Display unit, e.g. "reps", "kg", "min", "km". */
  unit: string;
  /** True when a smaller number is the improvement (e.g. a timed distance). */
  lowerIsBetter?: boolean;
  /** ISO timestamp of the baseline measurement. */
  measuredAt?: string;
  /** All measurements, oldest first. */
  history: BenchmarkPoint[];
}

/** One workout within a program, optionally the benchmark-measuring one. */
export interface ProgramWorkout {
  id: string;
  workout: Workout;
  /** True when finishing this workout measures one or more benchmarks. */
  isBenchmark?: boolean;
  /** Which Benchmark this workout measures (Benchmark.id). Kept for back-compat;
   *  new plans use `benchmarkIds` (a single assessment can measure several). */
  benchmarkId?: string;
  /** All Benchmarks this workout measures — an assessment can set several
   *  baselines at once (e.g. Murph: pull-ups + push-ups + run). Additive;
   *  when absent, `benchmarkId` (if any) is the single measured benchmark. */
  benchmarkIds?: string[];
  /**
   * Which group this workout belongs to (1-based). Group 1 is the evaluation
   * group; training groups follow. Absent on pre-groups plans — derived as
   * group 1 for benchmark/assessment workouts, group 2 otherwise.
   */
  group?: number;
  /** ISO timestamp the user finished (or manually checked off) this workout
   *  within its group. Cleared on clones when a new group is built. */
  completedAt?: string;
}

/**
 * A structured workout program attached to a Plan (get_fit / both). Additive —
 * absent for eat_better / logging_only and all pre-W4 plans. `analysisCursor`
 * is the session count at the last AI adaptation pass (W5).
 */
export interface WorkoutProgram {
  workouts: ProgramWorkout[];
  benchmarks: Benchmark[];
  /** Sessions logged when the adaptation engine last ran (W5). */
  analysisCursor?: number;
  /**
   * The group the user is currently working through (see ProgramWorkout.group).
   * Groups replace "weeks" — no dates, no falling behind: finish the group,
   * start the next. Absent on pre-groups plans; derived there (evaluation group
   * until every benchmark has a baseline, else the first training group).
   */
  currentGroup?: number;
  /**
   * How many groups make one cycle. The first group of every cycle is an
   * EVALUATION group (re-test the benchmarks); the rest are training groups.
   * Defaults to 4 (evaluation + 3 training groups).
   */
  groupsPerCycle?: number;
}

/**
 * Structured, per-plan targets — the plan's numeric metrics. `dailyCalories`
 * is null when the plan doesn't track food. This is the extension seam: new
 * metrics (steps, water, sleep…) are added here as optional fields, so the plan
 * stays the single home for what the user is aiming at. When present and food
 * is tracked, these drive the diary's rings (see planService.targetsToGoals).
 */
export interface PlanTargets {
  dailyCalories: number | null;
  /** Macro grams, derived from the calorie target at creation/edit. */
  protein?: number;
  carbs?: number;
  fat?: number;
}

/**
 * A finite 1–4 week plan. At most one is active at a time (`getPlan` returns it
 * or null). Generated by the wizard, validated by the safety layers, then
 * persisted whole so history never silently rewrites.
 */
export interface Plan {
  id: string;
  mode: PlanMode;
  /** 1–4. */
  durationWeeks: number;
  /** Inclusive start, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive end, YYYY-MM-DD. */
  endDate: string;
  goals: PlanGoal[];
  /** Structured nutrition/metric targets. Additive — absent on pre-1.2 plans;
   *  the diary falls back to stored Goals when this is missing. */
  targets?: PlanTargets;
  safety: SafetyIntake;
  liability: LiabilityAck;
  /** ISO timestamp the plan was created. */
  createdAt: string;
  /** The free-text goal the user typed in the wizard ("get better at the half
   *  Murph"). Additive — absent on pre-1.17 plans; the plan-edit diff then can't
   *  compare goal text for those and only mode/start-date fork a new plan. */
  goalText?: string;
  /**
   * How many DAYS a week the user wants to move, or absent/0 for "don't track
   * it". Deliberately days rather than sessions: "three times a week" is how
   * people say it, and counting sessions would double-count the same effort
   * when a wearable and a manual entry both land (which they do — see
   * features/exercise, where the two ADD together on purpose).
   *
   * Additive; absent on every plan before this shipped.
   */
  weeklyExerciseDays?: number;
  /** Structured, adaptive workout program (W4). Additive — absent on food-only
   *  and all pre-W4 plans. */
  program?: WorkoutProgram;
}

/**
 * A single day's plan progress. Meals are NOT duplicated here — they live in
 * the diary and are read by date; this record only holds what the diary can't
 * express (which plan goals were ticked, the day's weigh-in).
 */
export interface DailyCheckoff {
  /** YYYY-MM-DD. */
  date: string;
  /** Ids of PlanGoals completed this day. */
  goalsCompleted: string[];
  /** Optional weigh-in for the day, kg. */
  weightKg?: number;
  /** The evening "how did your day go?" coach check-in, once submitted. */
  checkin?: DayCheckin;
  /** Wearable/Apple-Health workouts the user removed from THIS day's exercise
   *  total. Keyed by `${start}-${workoutType}` (HealthKit gives no id). We can't
   *  delete from Apple Health, so we exclude locally (reversible). Additive. */
  excludedWearableKeys?: string[];
  /** Per-wearable-workout calorie overrides (same key), when the user edited the
   *  burned number. Additive/optional. */
  wearableKcalOverrides?: Record<string, number>;
}

/** A submitted end-of-day check-in — the answers as shown, verbatim. */
export interface DayCheckin {
  /** ISO timestamp of submission. */
  at: string;
  answers: { question: string; answer: string }[];
}

/** One mid-session "Tell coach" exchange logged on a WorkoutSession. */
export interface CoachReprompt {
  /** ISO timestamp. */
  at: string;
  /** What the user told the coach. */
  userText: string;
  /** The coach's adjustment / reply. */
  coachText: string;
  /** True when the symptom classifier (layer 3) ended the session here. */
  endedSession?: boolean;
}

/**
 * One recorded set. Timestamps bound the set so a "slow set" (the adaptation
 * engine's key signal) is derivable as completedAt − startedAt vs the
 * prescribed duration. All metric fields optional so a single shape covers
 * rep, timed, and weighted sets.
 */
export interface SetActual {
  reps?: number;
  weightKg?: number;
  durationSec?: number;
  /** Subjective exertion, 1–10 (RPE), when the user records it. */
  rpe?: number;
  /** ISO timestamp the set became active. */
  startedAt: string;
  /** ISO timestamp the user marked it done. */
  completedAt: string;
  /** Actual rest taken after this set, seconds. */
  restActualSec?: number;
}

/** A workout's recorded sets for one exercise, keyed for cross-session joins. */
export interface ExerciseActual {
  /** Normalized exercise name — the join key across sessions + explainers. */
  exerciseKey: string;
  /** Display name as prescribed. */
  name: string;
  sets: SetActual[];
}

/** Recorded result of a cardio (run/bike) session. */
export interface CardioActual {
  distanceKm: number;
  durationSec: number;
  avgPaceSecPerKm?: number;
  /** Where the distance came from. */
  source: "gps" | "steps" | "manual";
  /** Per-km split times, seconds. */
  splits?: number[];
  /** Raw GPS breadcrumb when tracked (t = epoch ms). */
  track?: { lat: number; lon: number; t: number; accuracy?: number }[];
}

/**
 * A completed (or abandoned) workout run. `planned`/`actual` are the legacy
 * flat snapshots (kept populated for back-compat); the structured
 * `byExercise` (strength) and `cardio` fields are the v2 record. Readers prefer
 * the structured fields when present.
 */
export interface WorkoutSession {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** The Workout this session was based on, when it came from the library. */
  workoutId?: string;
  /** Display name of the workout, for the "completed today" list. Additive. */
  workoutName?: string;
  planned: ExerciseSet[];
  actual: ExerciseSet[];
  reprompts: CoachReprompt[];
  /** Structured strength result — recorded sets grouped by exercise. */
  byExercise?: ExerciseActual[];
  /** Structured cardio result, for run/bike sessions. */
  cardio?: CardioActual;
  /** Set when this session was a benchmark run (links to Plan benchmark). */
  benchmarkId?: string;
  /** Benchmarks this session measured, when it was an assessment covering
   *  several (e.g. a Murph test). Union'd with `benchmarkId` at fold-in. */
  benchmarkIds?: string[];
  /** ISO timestamp the session finished. */
  completedAt: string;
  /** Wall-clock length of the session in seconds (start → finish). Additive —
   *  absent on pre-1.18 sessions; used to estimate calories burned. Cardio also
   *  carries duration on `cardio.durationSec`. */
  durationSec?: number;
  /** Active energy burned, kcal — from the wearable/health broker, a manual
   *  log, or the in-app post-workout estimate. Feeds the diary's exercise-
   *  calories add-back. Additive/optional. */
  caloriesBurned?: number;
  /** Where the session came from. Absent = in-app player (default). */
  source?: "manual" | "healthkit" | "health_connect" | "logWorkout";
}

// ── Derived view models ──────────────────────────────────────────────

/** A day's diary grouped by meal, with totals — computed in features/diary. */
export interface DayView {
  date: string;
  meals: Record<MealType, DiaryEntry[]>;
  perMeal: Record<MealType, Macros>;
  total: Macros;
}
