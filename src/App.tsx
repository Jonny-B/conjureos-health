import { useCallback, useEffect, useMemo, useState } from "react";
import type { Goals, MealType, Plan, Profile } from "./types";
import { DEFAULT_GOALS } from "./types";
import { getRepository } from "./data/repository";
import { registerActions } from "./bridge/actions";
import { todayISO } from "./features/diary";
import {
  archivePlan,
  commitNewPlan,
  loadPlan,
  modifyPlanInPlace,
  targetsToGoals,
  type WizardBody,
} from "./features/plan/planService";
import { DiaryScreen } from "./screens/DiaryScreen";
import { MealDetailScreen } from "./screens/MealDetailScreen";
import { WizardScreen } from "./screens/WizardScreen";
import { PlanBanner } from "./components/PlanBanner";
import { AddFoodScreen, type AddMode } from "./screens/AddFoodScreen";
import { PlanScreen } from "./screens/PlanScreen";
import { JournalScreen } from "./screens/JournalScreen";
import { ExerciseScreen } from "./screens/ExerciseScreen";
import { SettingsSheet } from "./screens/SettingsSheet";
import { AppHeader } from "./components/AppHeader";
import { SaveFailedNotice } from "./components/SaveFailedNotice";
import { AddIcon, AppleIcon, CalendarIcon, DiaryIcon, TrendsIcon } from "./components/icons";
import { MEAL_LABELS } from "./types";
import type { ComponentType } from "react";

type Tab = "diary" | "meal" | "add" | "plan" | "journal" | "exercise";

/** Sensible default meal when opening Add from the tab bar (no meal context) —
 *  by time of day. The user can still switch it in the Add screen. */
function mealForNow(): MealType {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 21) return "dinner";
  return "snacks";
}

/**
 * Root component and the app's single source of navigation + shared state.
 *
 * Owns the active tab, the selected date, and the cached profile/goals/plan
 * that most screens read, passing them down rather than letting screens hit the
 * repository independently. A `nonce` counter is bumped after any write so
 * mounted children re-read; that's the app-wide invalidation signal.
 */
export function App() {
  const [tab, setTab] = useState<Tab>("diary");
  const [date, setDate] = useState<string>(todayISO());
  const [goals, setGoals] = useState<Goals>(DEFAULT_GOALS);
  const [profile, setProfile] = useState<Profile | null>(null);
  // v2: the active plan. null → show the "build your plan" banner (no longer a
  // full-screen gate; the app is usable for logging without a plan).
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Plan wizard as a dismissible dialog, plus a per-session dismiss for its
  // banner (resets on reload = shows again while there's still no plan).
  const [planWizardOpen, setPlanWizardOpen] = useState(false);
  // The plan currently being edited (edit mode) vs null = create-a-new-plan.
  // Both open the same full-screen WizardScreen.
  const [planEditor, setPlanEditor] = useState<Plan | null>(null);
  const [planBannerDismissed, setPlanBannerDismissed] = useState(false);
  // The meal the Add flow should default to when opened from a meal's "+".
  const [addMeal, setAddMeal] = useState<MealType>("breakfast");
  // Which input the Add screen opens on (Scan when launched from a meal's Scan CTA).
  const [addMode, setAddMode] = useState<AddMode>("search");
  // Where the Add screen returns on log/cancel: back to the meal it came from,
  // or the diary. Keeps "add another to lunch" flowing without a detour.
  const [addReturn, setAddReturn] = useState<Tab>("diary");
  // The meal shown by the meal-detail screen.
  const [activeMeal, setActiveMeal] = useState<MealType>("breakfast");
  // Bumped after any write so the Diary reloads from the repository.
  const [nonce, setNonce] = useState(0);

  /**
   * Re-read everything a reset can have changed. Bumping `nonce` alone only
   * makes mounted screens refetch THEIR data — the plan lives in App state, so
   * clearing it left the Plan tab rendering a plan that no longer existed.
   */
  const onDataCleared = useCallback(async () => {
    const repo = await getRepository();
    const [g, p, existingPlan] = await Promise.all([repo.getGoals(), repo.getProfile(), loadPlan()]);
    setGoals(g);
    setProfile(p);
    setPlan(existingPlan);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const repo = await getRepository();
      const [g, p, existingPlan] = await Promise.all([repo.getGoals(), repo.getProfile(), loadPlan()]);
      if (!alive) return;
      setGoals(g);
      setProfile(p);
      setPlan(existingPlan);
      setReady(true);
    })();
    registerActions().catch(() => {
      /* cross-app integration is non-fatal */
    });
    return () => {
      alive = false;
    };
  }, []);

  // The diary's rings read from the plan's targets when it tracks food, falling
  // back to the separately-stored goals otherwise.
  const effectiveGoals = useMemo(() => targetsToGoals(plan, goals), [plan, goals]);

  const openAdd = useCallback(
    (meal: MealType, mode: AddMode = "search", returnTo: Tab = "diary") => {
      setAddMeal(meal);
      setAddMode(mode);
      setAddReturn(returnTo);
      setTab("add");
    },
    [],
  );

  const openMeal = useCallback((meal: MealType) => {
    setActiveMeal(meal);
    setTab("meal");
  }, []);

  const onLogged = useCallback(() => {
    setNonce((n) => n + 1);
    setTab(addReturn);
  }, [addReturn]);

  const onSaveGoals = useCallback((g: Goals, p: Profile | null) => {
    setGoals(g);
    if (p) setProfile(p);
  }, []);

  const onWizardComplete = useCallback(
    async (created: Plan, body: WizardBody) => {
      // Rebuilding over an existing plan: archive the outgoing one first so
      // history/insight survives (diary/weight/exercise history is separate and
      // untouched).
      if (plan) await archivePlan(plan);
      const res = await commitNewPlan(created, { body, currentProfile: profile, currentGoals: goals });
      setPlan(res.plan);
      setProfile(res.profile);
      setGoals(res.goals);
      setPlanWizardOpen(false);
      setPlanEditor(null);
      setPlanBannerDismissed(false);
      setNonce((n) => n + 1);
      setTab("diary");
    },
    [plan, profile, goals],
  );

  // Edit-mode, non-forking change: modify the current plan in place (keep id,
  // program, group progress) and recompute the calorie target. No archive, no
  // recordPlanStarted — this is the same plan, not a new episode.
  const onModifyPlan = useCallback(
    async (body: WizardBody, patch: { endDate?: string; durationWeeks?: number }) => {
      if (!plan) return;
      const res = await modifyPlanInPlace(plan, body, patch, {
        currentProfile: profile,
        currentGoals: goals,
      });
      setPlan(res.plan);
      if (res.profile) setProfile(res.profile);
      setGoals(res.goals);
      setPlanWizardOpen(false);
      setPlanEditor(null);
      setNonce((n) => n + 1);
      setTab("plan");
    },
    [plan, profile, goals],
  );

  /** Open the wizard to build a brand-new plan (no plan to edit). */
  const startNewPlan = useCallback(() => {
    setSettingsOpen(false);
    setPlanEditor(null);
    setPlanWizardOpen(true);
  }, []);

  /** Open the wizard in edit mode, prefilled from the active plan. */
  const editPlan = useCallback(() => {
    if (!plan) return;
    setSettingsOpen(false);
    setPlanEditor(plan);
    setPlanWizardOpen(true);
  }, [plan]);

  // The plan wizard, opened from the banner, owns the screen while active but is
  // fully dismissible (no longer a mandatory first-run gate).
  if (ready && planWizardOpen) {
    return (
      <div className="app">
        <main className="screen">
          <WizardScreen
            onComplete={onWizardComplete}
            onModify={onModifyPlan}
            editPlan={planEditor}
            onClose={() => {
              setPlanWizardOpen(false);
              setPlanEditor(null);
            }}
            units={profile?.units ?? "metric"}
            profile={profile}
          />
        </main>
      </div>
    );
  }

  const planBanner =
    ready && !plan && !planBannerDismissed ? (
      <PlanBanner onOpen={() => setPlanWizardOpen(true)} onDismiss={() => setPlanBannerDismissed(true)} />
    ) : null;

  const diaryScreen = (
    <DiaryScreen
      date={date}
      goals={effectiveGoals}
      onMutated={() => setNonce((n) => n + 1)}
      banner={planBanner}
      nonce={nonce}
      plan={plan}
      profile={profile}
      onChangeDate={setDate}
      onOpenMeal={openMeal}
      onOpenPlan={() => setTab("plan")}
      onOpenExercise={() => setTab("exercise")}
    />
  );

  // Context-aware header: title + optional back per current surface.
  const header: { title: string; onBack?: () => void } =
    tab === "meal"
      ? { title: MEAL_LABELS[activeMeal], onBack: () => setTab("diary") }
      : tab === "add"
        ? {
            title: addMode === "scan" ? "Scan Barcode" : addMode === "ai" ? "AI" : "Search",
            onBack: () => setTab(addReturn),
          }
        : tab === "plan"
          ? { title: "Plan" }
          : tab === "journal"
            ? { title: "Journal" }
          : tab === "exercise"
            ? { title: "Exercise", onBack: () => setTab("diary") }
            : { title: "Conjure Health" };

  return (
    <div className="app">
      <AppHeader title={header.title} onBack={header.onBack} onSettings={() => setSettingsOpen(true)} />
      <SaveFailedNotice />

      <main className="screen">
        {!ready ? (
          <div className="center-fill">
            <div className="spinner" />
          </div>
        ) : tab === "diary" ? (
          diaryScreen
        ) : tab === "meal" ? (
          <MealDetailScreen
            date={date}
            meal={activeMeal}
            goals={effectiveGoals}
            nonce={nonce}
            onScan={() => openAdd(activeMeal, "scan", "meal")}
            onSearch={() => openAdd(activeMeal, "search", "meal")}
            onAi={() => openAdd(activeMeal, "ai", "meal")}
            onMutated={() => setNonce((n) => n + 1)}
            units={profile?.units ?? "metric"}
          />
        ) : tab === "add" ? (
          <AddFoodScreen
            date={date}
            defaultMeal={addMeal}
            defaultMode={addMode}
            onLogged={onLogged}
            onCancel={() => setTab(addReturn)}
            onModeChange={setAddMode}
            units={profile?.units ?? "metric"}
          />
        ) : tab === "journal" ? (
          <JournalScreen units={profile?.units ?? "metric"} nonce={nonce} />
        ) : tab === "plan" ? (
          <PlanScreen
            nonce={nonce}
            profile={profile}
            plan={plan}
            goals={effectiveGoals}
            onPlanChange={setPlan}
            onEditPlan={editPlan}
            onStartPlan={startNewPlan}
          />
        ) : tab === "exercise" ? (
          <ExerciseScreen date={date} nonce={nonce} onMutated={() => setNonce((n) => n + 1)} />
        ) : (
          diaryScreen
        )}
      </main>

      <nav className="tabbar">
        {/* Desktop only (hidden below the rail breakpoint): with the tab bar
            turned into a left rail, the rail is where the app's identity
            belongs — otherwise the nav starts flush against the header. */}
        <div className="rail-brand" aria-hidden>
          <span className="brand-mark">
            <AppleIcon />
          </span>
          <span className="rail-brand-name">Conjure Health</span>
        </div>
        <TabButton
          label="Diary"
          Icon={DiaryIcon}
          active={tab === "diary" || tab === "meal" || tab === "exercise"}
          onClick={() => setTab("diary")}
        />
        <TabButton label="Add" Icon={AddIcon} active={tab === "add"} onClick={() => openAdd(mealForNow())} />
        <TabButton label="Plan" Icon={TrendsIcon} active={tab === "plan"} onClick={() => setTab("plan")} />
        <TabButton label="Journal" Icon={CalendarIcon} active={tab === "journal"} onClick={() => setTab("journal")} />
      </nav>

      <div className="app-version">v{__APP_VERSION__}</div>

      {settingsOpen && (
        <SettingsSheet
          goals={goals}
          profile={profile}
          onClose={() => setSettingsOpen(false)}
          onSave={onSaveGoals}
          onDataCleared={onDataCleared}
        />
      )}
    </div>
  );
}

function TabButton({
  label,
  Icon,
  active,
  onClick,
}: {
  label: string;
  Icon: ComponentType<{ size?: number }>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`tab${active ? " active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
      <span className="tab-icon" aria-hidden>
        <Icon size={22} />
      </span>
      <span className="tab-label">{label}</span>
    </button>
  );
}
