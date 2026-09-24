import { useEffect, useState, type ReactNode } from "react";
import type { DayView, Goals, MealType, Plan, Profile } from "../types";
import { MEAL_LABELS } from "../types";
import { getRepository } from "../data/repository";
import { buildDayView, shiftDate, todayISO } from "../features/diary";
import { CalorieRing, MacroBars } from "../components/rings";
import { ChevronLeft, ChevronRight, WorkoutsIcon } from "../components/icons";
import { WeightCard } from "../components/WeightCard";
import { CoachPlanCard } from "../components/CoachPlanCard";
import { AskCoachCard } from "../components/AskCoachCard";
import { WellbeingCard } from "../components/WellbeingCard";
import { CoachChatModal } from "../components/CoachChatModal";
import { exerciseCaloriesForDate } from "../features/exercise";

interface Props {
  date: string;
  goals: Goals;
  /** Optional banner (e.g. "build your plan") shown above the Today tracker. */
  banner?: ReactNode;
  nonce: number;
  plan: Plan | null;
  profile: Profile | null;
  onChangeDate: (date: string) => void;
  onOpenMeal: (meal: MealType) => void;
  onOpenPlan: () => void;
  onOpenWorkouts: () => void;
  /** Fired when this screen writes something the shell also renders. */
  onMutated: () => void;
}

/** The home tab: calorie ring, macro bars, weight card, plan card, and the
 *  day's meals. Re-reads whenever `date` or `nonce` changes. */
export function DiaryScreen({
  date,
  goals,
  banner,
  nonce,
  plan,
  profile,
  onChangeDate,
  onOpenMeal,
  onOpenPlan,
  onOpenWorkouts,
  onMutated,
}: Props) {
  const [view, setView] = useState<DayView | null>(null);
  // Exercise calories for the day — added back to the budget.
  const [exercise, setExercise] = useState(0);
  // The question in flight; non-null also means the chat sheet is open.
  const [asking, setAsking] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const repo = await getRepository();
      const entries = await repo.listDiary(date);
      if (alive) setView(buildDayView(date, entries));
      // Exercise calories = wearable (Apple Health, etc.) + in-app sessions,
      // added together, minus any the user removed. See features/exercise.
      const burned = await exerciseCaloriesForDate(date).catch(() => 0);
      if (alive) setExercise(burned);
    })();
    return () => {
      alive = false;
    };
  }, [date, nonce]);

  const isToday = date === todayISO();
  const total = view?.total ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const mealCal = (m: MealType) => view?.perMeal[m].calories ?? 0;

  return (
    <div className="diary">
      {banner}

      {/* These two wrappers exist ONLY for the desktop layout, where they
          become the primary and secondary columns. Below the breakpoint they
          are `display: contents`, so the phone layout is exactly as it was. */}
      <div className="diary-main">
        <div className="date-nav">
          <button className="icon-btn" aria-label="Previous day" onClick={() => onChangeDate(shiftDate(date, -1))}>
            <ChevronLeft size={20} />
          </button>
          <button
            className="date-label"
            onClick={() => onChangeDate(todayISO())}
            title={isToday ? undefined : "Jump to today"}
          >
            {isToday ? "Today" : formatDate(date)}
          </button>
          <button
            className="icon-btn"
            aria-label="Next day"
            disabled={isToday}
            onClick={() => onChangeDate(shiftDate(date, 1))}
          >
            <ChevronRight size={20} />
          </button>
        </div>

        <section className="budget-card">
          <div className="budget-head">
            <span className="budget-label">Calorie Budget</span>
            <span className="budget-value">{goals.calories.toLocaleString()}</span>
          </div>

          <div className="budget-grid">
            <div className="budget-col">
              <MealStat label={MEAL_LABELS.breakfast} cal={mealCal("breakfast")} onClick={() => onOpenMeal("breakfast")} />
              <MealStat label={MEAL_LABELS.lunch} cal={mealCal("lunch")} onClick={() => onOpenMeal("lunch")} />
            </div>
            <CalorieRing consumed={total.calories} goal={goals.calories} exercise={exercise} />
            <div className="budget-col">
              <MealStat label={MEAL_LABELS.dinner} cal={mealCal("dinner")} onClick={() => onOpenMeal("dinner")} />
              <MealStat label={MEAL_LABELS.snacks} cal={mealCal("snacks")} onClick={() => onOpenMeal("snacks")} />
            </div>
          </div>

          {/* Workout item — opens the Workouts view. Calories burned add back to
              the day's budget (reflected in the ring + the summary below). */}
          <button className="workout-stat" onClick={onOpenWorkouts} aria-label="Open workouts">
            <span className="workout-stat-icon" aria-hidden>
              <WorkoutsIcon size={18} />
            </span>
            <span className="workout-stat-body">
              <span className="workout-stat-label">Exercise</span>
              <span className="workout-stat-sub">
                {exercise > 0 ? `+${exercise} cal back in your budget` : "Log or sync a workout"}
              </span>
            </span>
            <span className="workout-stat-cal">{exercise > 0 ? `+${exercise}` : ""}</span>
            <ChevronRight size={18} />
          </button>

          <div className="budget-foot">
            <span className="summary-eaten">
              <strong>{total.calories}</strong> eaten
              {exercise > 0 ? <> · <strong>{exercise}</strong> burned</> : null} · goal{" "}
              {goals.calories.toLocaleString()}
            </span>
          </div>

          <MacroBars total={total} goals={goals} />
        </section>

      </div>

      <div className="diary-side">
        <WeightCard profile={profile} nonce={nonce} />
        <WellbeingCard
          date={date}
          units={profile?.units ?? "metric"}
          nonce={nonce}
          onMutated={onMutated}
        />
        <CoachPlanCard plan={plan} goals={goals} onOpen={onOpenPlan} />
        <AskCoachCard onAsk={setAsking} />
      </div>

      {asking !== null && <CoachChatModal initialQuestion={asking} onClose={() => setAsking(null)} />}
    </div>
  );
}

function MealStat({ label, cal, onClick }: { label: string; cal: number; onClick: () => void }) {
  return (
    <button className="meal-stat" onClick={onClick} aria-label={`Open ${label}`}>
      <span className="meal-stat-label">{label}</span>
      <span className="meal-stat-cal">{cal}</span>
    </button>
  );
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
