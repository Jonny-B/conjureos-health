import { useEffect, useRef, useState } from "react";
import { aiErrorMessage, type ChatImage } from "../bridge/ai";
import type { FoodItem, MealType, Profile } from "../types";
import {
  fromServings,
  isVolume,
  stepFor,
  toServings,
  unitsFor,
  UNIT_LABELS,
  type AmountUnit,
} from "../features/servingUnits";
import { MEAL_LABELS, MEAL_TYPES } from "../types";
import { getRepository } from "../data/repository";
import { searchFoods, lookupBarcode, rememberCorrection } from "../features/foods/foodSearch";
import { parseMealWithGroup } from "../features/naturalLanguage";
import { groupItems, suggestGroupName } from "../features/grouping";
import { recentFoodsForMeal, type RecentFood } from "../features/recentFoods";
import { isValidBarcode } from "../features/barcode";
import { useScrollLock } from "../hooks/useScrollLock";
import {
  listRecipes,
  markCooked,
  getResolvedRecipeProviderName,
  type ListedRecipe,
} from "../bridge/recipeBridge";
import { BarcodeScanner } from "../components/BarcodeScanner";
import { NumberField } from "../components/NumberField";
import { MIN_QTY } from "./MealDetailScreen";
import { CameraCapture } from "../components/CameraCapture";
import { SymptomSheet } from "../components/SymptomSheet";
import { PackageCapture, type PackageResult } from "../components/PackageCapture";
import { EditableNutritionPreview } from "../components/EditableNutritionPreview";
import {
  CUSTOM_SERVING_UNITS,
  customFoodProblem,
  saveCustomFood,
} from "../features/foods/customFoods";
import {
  BarcodeIcon,
  ChevronLeft,
  ChevronRight,
  DiamondIcon,
  EditIcon,
  NutritionPanelIcon,
  SearchIcon,
  TrashIcon,
} from "../components/icons";

/** The three logging surfaces, each reached directly from a meal's buttons. */
export type AddMode = "search" | "scan" | "ai";

interface PickOpts {
  recipeSlug?: string;
  /** Preset the serving stepper (used when re-logging a recent saved item). */
  initialQty?: number;
}

interface Props {
  date: string;
  defaultMeal: MealType;
  /** Which surface to open on. */
  defaultMode?: AddMode;
  onLogged: () => void;
  onCancel: () => void;
  /** Fired when the user switches input mode inside the screen, so the shell
   *  header can track it (Scan Barcode / AI / Search). */
  onModeChange?: (mode: AddMode) => void;
  /** Display preference; orders the amount-unit picker. */
  units?: Profile["units"];
}

/** Order matters and is shared with the meal screen's buttons: Scan, then AI,
 *  then Search. AI sits second because describing or photographing a meal
 *  answers more of the time than a text search does; Search is the fallback
 *  for when you already know exactly what you want. */
const MODE_TABS: { mode: AddMode; label: string; Icon: typeof SearchIcon }[] = [
  { mode: "scan", label: "Scan", Icon: BarcodeIcon },
  { mode: "ai", label: "AI", Icon: DiamondIcon },
  { mode: "search", label: "Search", Icon: SearchIcon },
];

/** The add-food surface, hosting all three entry paths — barcode Scan, text
 *  Search, and AI (photo or description). `onLogged` fires once per save. */
export function AddFoodScreen({
  date,
  defaultMeal,
  defaultMode = "search",
  onLogged,
  onModeChange,
  units = "metric",
}: Props) {
  const [selected, setSelected] = useState<{
    food: FoodItem;
    recipeSlug?: string;
    initialQty?: number;
  } | null>(null);
  // Mode + meal are switchable in-place, so the Add flow works meal-agnostically
  // (e.g. opened from the tab bar, not just a meal's button) and lets the user
  // change either without backing out.
  const [mode, setMode] = useState<AddMode>(defaultMode);
  const [meal, setMeal] = useState<MealType>(defaultMeal);
  // A food the user has told us is wrong.
  const [fixing, setFixing] = useState<{ food: FoodItem } | null>(null);
  // The "Add your own food" form, prefilled with whatever was searched.
  const [creating, setCreating] = useState<{ name: string } | null>(null);

  const changeMode = (m: AddMode) => {
    setMode(m);
    onModeChange?.(m);
  };

  const pick = (food: FoodItem, opts?: PickOpts) =>
    setSelected({ food, recipeSlug: opts?.recipeSlug, initialQty: opts?.initialQty });

  if (creating) {
    return (
      <CustomFoodForm
        initialName={creating.name}
        onSaved={(food) => {
          setCreating(null);
          setSelected({ food });
        }}
        onCancel={() => setCreating(null)}
      />
    );
  }

  if (fixing) {
    return (
      <FixFlow
        food={fixing.food}
        onFixed={async (food) => {
          // Local first: the user's numbers win on their own device whatever
          // the community DB decides to do with the submission.
          if (food.barcode) await rememberCorrection(food.barcode, food);
          setFixing(null);
          setSelected({ food });
        }}
        onCancel={() => setFixing(null)}
      />
    );
  }

  if (selected) {
    return (
      <LogPanel
        food={selected.food}
        recipeSlug={selected.recipeSlug}
        initialQty={selected.initialQty ?? 1}
        units={units}
        date={date}
        defaultMeal={meal}
        onLogged={onLogged}
        onBack={() => setSelected(null)}
        onFix={() => {
          setSelected(null);
          setFixing({ food: selected.food });
        }}
      />
    );
  }

  return (
    <div className="add">
      <div className="add-toolbar">
        <div className="mode-switch" role="tablist" aria-label="Add method">
          {MODE_TABS.map(({ mode: m, label, Icon }) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`mode-tab${mode === m ? " active" : ""}`}
              onClick={() => changeMode(m)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <label className="add-meal-select">
          <span className="add-meal-label">Meal</span>
          <MealPicker meal={meal} onChange={setMeal} />
        </label>
      </div>

      {mode === "search" && <SearchMode meal={meal} onPick={pick} onAddOwn={(name) => setCreating({ name })} />}
      {mode === "scan" && <ScanMode onPick={(food) => pick(food)} />}
      {/* `meal` is passed straight through (not as a "default") — the toolbar
          picker above is the single source of truth for all three modes, AI
          included. AiMode used to keep its own copy seeded from this value,
          which is how the meal a photo/description logged to could silently
          diverge from what the toolbar showed. */}
      {mode === "ai" && <AiMode date={date} meal={meal} onLogged={onLogged} />}
    </div>
  );
}

// ── Search ─────────────────────────────────────────────────────────────

const MIN_SEARCH_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 250;

function SearchMode({
  meal,
  onPick,
  onAddOwn,
}: {
  meal: MealType;
  onPick: (food: FoodItem, opts?: PickOpts) => void;
  onAddOwn: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoodItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [recents, setRecents] = useState<RecentFood[]>([]);
  const [recipes, setRecipes] = useState<{ recipe: ListedRecipe; provider: string }[]>([]);

  const trimmed = query.trim();
  const ready = trimmed.length >= MIN_SEARCH_CHARS;

  // Meal-scoped recent saved items, shown as the empty-state suggestion list.
  useEffect(() => {
    let alive = true;
    recentFoodsForMeal(meal)
      .then((r) => {
        if (alive) setRecents(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meal]);

  useEffect(() => {
    if (!ready) {
      setResults([]);
      setRecipes([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        // Paint each provider's hits as they land so a fast USDA response shows
        // immediately instead of waiting on a slow Open Food Facts request.
        const found = await searchFoods(trimmed, 20, controller.signal, (partial) => {
          if (!controller.signal.aborted) setResults(partial);
        });
        if (!controller.signal.aborted) {
          setResults(found);
          setSearching(false);
        }
      } catch {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
  }, [trimmed, ready]);

  // "Search your other apps" — providers only expose list-all and may ignore
  // the filter, so we client-filter by title. Feature-detects: no provider →
  // empty, section hidden.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    listRecipes(trimmed)
      .then((all) => {
        if (!alive) return;
        const q = trimmed.toLowerCase();
        const provider = getResolvedRecipeProviderName() ?? "Recipes";
        const hits = all
          .filter((r) => r.title.toLowerCase().includes(q))
          .slice(0, 20)
          .map((recipe) => ({ recipe, provider }));
        setRecipes(hits);
      })
      .catch(() => {
        if (alive) setRecipes([]);
      });
    return () => {
      alive = false;
    };
  }, [trimmed, ready]);

  return (
    <div className="mode-body">
      <div className={`search-field${searching ? " searching" : ""}`}>
        <SearchIcon size={18} className="search-field-icon" />
        <input
          className="text-input"
          placeholder="Search foods (e.g. greek yogurt)"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        {searching && <span className="search-field-spinner" aria-label="Searching" />}
      </div>

      {!ready ? (
        recents.length > 0 ? (
          <>
            <div className="section-label">Recent in {MEAL_LABELS[meal]}</div>
            <ul className="food-results">
              {recents.map((r, i) => (
                <li key={`recent-${i}`}>
                  <button
                    className="food-result"
                    onClick={() => onPick(r.food, { initialQty: r.quantity })}
                  >
                    <div className="entry-main">
                      <div className="entry-name">{r.food.name}</div>
                      <div className="entry-sub">
                        {r.quantity}× {r.food.servingSize}
                        {r.food.brand ? ` · ${r.food.brand}` : ""}
                      </div>
                    </div>
                    <div className="entry-cal">{Math.round(r.food.perServing.calories * r.quantity)}</div>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="muted small">Type at least {MIN_SEARCH_CHARS} letters to search.</div>
        )
      ) : (
        <>
          {searching && <div className="muted small">Searching Open Food Facts + USDA…</div>}
          <FoodResultList
            foods={results}
            onPick={onPick}
            emptyHint={searching ? "Searching…" : "No matches. Try a simpler term, or add it yourself."}
          />
          {!searching && results.length === 0 && (
            <button className="btn primary block add-own-food" onClick={() => onAddOwn(trimmed)}>
              Add "{trimmed}" as your own food
            </button>
          )}
          {recipes.length > 0 && (
            <>
              <div className="section-label">From your apps</div>
              <ul className="food-results">
                {recipes.map(({ recipe: r, provider }) => {
                  const n = r.nutrition;
                  return (
                    <li key={`recipe-${r.slug}`}>
                      <button
                        className="food-result"
                        disabled={!n}
                        onClick={() =>
                          n &&
                          onPick(
                            {
                              id: r.slug,
                              source: "recipe",
                              name: r.title,
                              perServing: {
                                calories: n.calories,
                                protein: n.protein,
                                carbs: n.carbs,
                                fat: n.fat,
                              },
                              servingSize: "1 serving",
                            },
                            { recipeSlug: r.slug },
                          )
                        }
                      >
                        <div className="entry-main">
                          <div className="entry-name-row">
                            <span className="entry-name">{r.title}</span>
                            <span className="app-pill" title={`From ${provider}`}>
                              <DiamondIcon size={11} className="app-pill-icon" />
                              {provider}
                            </span>
                          </div>
                          <div className="entry-sub">
                            {n ? `~${n.calories} cal · ${n.protein}g P` : "no nutrition data"}
                          </div>
                        </div>
                        <div className="entry-cal">{n?.calories ?? "–"}</div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
      <button className="btn log-report add-own-food" onClick={() => onAddOwn(ready ? trimmed : "")}>
        Add your own food
      </button>
    </div>
  );
}

/** Detections at or above this many items are grouped by default — that many
 *  separate diary rows is the problem grouping was added to solve. */
const GROUP_BY_DEFAULT_AT = 5;

/** A labelled switch with a line explaining what it will actually do. */
function ToggleRow({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button className="toggle-row" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        <span className="toggle-hint muted small">{hint}</span>
      </span>
      <span className={`toggle-track${on ? " on" : ""}`} aria-hidden>
        <span className="toggle-knob" />
      </span>
    </button>
  );
}

// ── Scan (barcode) ───────────────────────────────────────────────────────

type CaptureMode = "photo" | null;

interface PendingPreview {
  food: FoodItem;
  source: "ai_label" | "ai_front";
  confidence: number;
  warningNote?: string;
}

function ScanMode({ onPick }: { onPick: (food: FoodItem) => void }) {
  const [manual, setManual] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [missedBarcode, setMissedBarcode] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureMode>(null);
  const [pendingPreview, setPendingPreview] = useState<PendingPreview | null>(null);
  const busy = useRef(false);

  const resolve = async (barcode: string) => {
    if (busy.current) return;
    busy.current = true;
    setStatus(`Looking up ${barcode}…`);
    try {
      const food = await lookupBarcode(barcode);
      if (food) {
        onPick(food);
      } else {
        setStatus(null);
        setMissedBarcode(barcode);
      }
    } finally {
      busy.current = false;
    }
  };

  if (pendingPreview) {
    return (
      <EditableNutritionPreview
        initial={pendingPreview.food}
        source={pendingPreview.source}
        aiConfidence={pendingPreview.confidence}
        warningNote={pendingPreview.warningNote}
        onConfirm={(food) => {
          setPendingPreview(null);
          setCapture(null);
          setMissedBarcode(null);
          onPick(food);
        }}
        onCancel={() => setPendingPreview(null)}
      />
    );
  }

  // Reached from a barcode miss or from the scanner's "snap a photo" shortcut.
  if (capture === "photo" || missedBarcode) {
    return (
      <>
        {missedBarcode && (
          <div className="mode-body snap-miss-head">
            <div className="snap-miss-barcode-row">
              <span className="chip muted">No match</span>
              <span className="muted small">{missedBarcode}</span>
            </div>
            <div className="muted small">
              We checked our database and Open Food Facts. Photograph it and we'll do the rest.
            </div>
          </div>
        )}
        <PackageCapture
          barcode={missedBarcode ?? undefined}
          onParsed={(res) =>
            setPendingPreview({
              food: res.food,
              source: res.source,
              confidence: res.confidence,
              ...(res.warningNote ? { warningNote: res.warningNote } : {}),
            })
          }
          onCancel={() => {
            setCapture(null);
            setMissedBarcode(null);
            setManual("");
          }}
        />
      </>
    );
  }

  return (
    <div className="mode-body scan-surface">
      <BarcodeScanner
        onDetected={resolve}
        onError={(m) => setStatus(m)}
        onEnterBarcode={() => setManualOpen((v) => !v)}
        onSnapPhoto={() => setCapture("photo")}
      />
      {manualOpen && (
        <div className="manual-barcode">
          <input
            className="text-input"
            placeholder="Barcode number"
            inputMode="numeric"
            autoFocus
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button className="btn" disabled={!isValidBarcode(manual)} onClick={() => resolve(manual.replace(/\D/g, ""))}>
            Look up
          </button>
        </div>
      )}
      {status && <div className="muted small">{status}</div>}
    </div>
  );
}


// ── AI (photograph a meal / describe it) ─────────────────────────────────

type AiTab = "photo" | "text";

function AiMode({
  date,
  meal,
  onLogged,
}: {
  date: string;
  /** Owned by the parent toolbar's MealPicker — AiMode has no meal state of
   *  its own so there is exactly one control that can retarget a log. */
  meal: MealType;
  onLogged: () => void;
}) {
  // Opens on the text path. Most logging happens after the meal, from memory,
  // and <CameraCapture> asks for camera permission the moment it mounts, so the
  // camera waits until the user picks the photo tab (ConjureOS #542).
  const [tab, setTab] = useState<AiTab>("text");
  const [text, setText] = useState("");
  const [items, setItems] = useState<FoodItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the estimator answered with nothing we could read. Kept apart
  // from `error` (a thrown call) and from an empty `items` (it answered, and
  // genuinely saw no food) so the user is told which of the three happened.
  const [unreadable, setUnreadable] = useState(false);
  // The last input, so "Try again" doesn't mean "retype it".
  const [lastInput, setLastInput] = useState<{ text?: string; image?: ChatImage } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  // Index of the parsed item being edited inline, or null for the list view.
  const [editing, setEditing] = useState<number | null>(null);
  // Log the detection as one dish instead of its parts. Off by default: the
  // itemised view is what lets someone delete the thing that wasn't theirs.
  const [grouped, setGrouped] = useState(false);
  const [groupName, setGroupName] = useState("");
  // Whether these entries should come back as re-log suggestions. On by
  // default, because that is right for the everyday case; the escape hatch is
  // for the twenty-item cheese board.
  const [toHistory, setToHistory] = useState(true);

  const removeItem = (i: number) =>
    setItems((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
  const replaceItem = (i: number, food: FoodItem) =>
    setItems((prev) => (prev ? prev.map((f, idx) => (idx === i ? food : f)) : prev));

  // Guards against a stale estimate landing after a newer one: retake() and
  // the tab switch both bump this, so a run() that was already in flight
  // recognises on resolution that it's no longer the current one and drops
  // its result instead of overwriting whatever the newer run produced.
  const runIdRef = useRef(0);

  const run = async (input: { text?: string; image?: ChatImage }) => {
    const myRunId = ++runIdRef.current;
    setBusy(true);
    setError(null);
    setUnreadable(false);
    setItems(null);
    setLastInput(input);
    try {
      const res = await parseMealWithGroup(input);
      if (runIdRef.current !== myRunId) return; // superseded — a retake/newer run already took over
      if (res.outcome === "unreadable") {
        setUnreadable(true);
        setItems(null);
        return;
      }
      setItems(res.items);
      setGroupName(res.groupName);
      // A long detection is exactly the case grouping exists for, so lead with
      // it turned on rather than making the user notice the toggle.
      setGrouped(res.items.length >= GROUP_BY_DEFAULT_AT);
      setToHistory(res.items.length < GROUP_BY_DEFAULT_AT);
    } catch (err) {
      if (runIdRef.current !== myRunId) return;
      setError(aiErrorMessage(err, "The estimator didn’t answer. Try again."));
    } finally {
      if (runIdRef.current === myRunId) setBusy(false);
    }
  };

  const onCapture = (image: ChatImage, previewUrl: string) => {
    setShotUrl(previewUrl);
    run({ image });
  };

  const retake = () => {
    // Invalidate whatever run() is in flight — without this a slow response
    // for the photo being replaced can still resolve after the retake and
    // overwrite the (or a newer) screen with its stale items.
    runIdRef.current++;
    setBusy(false);
    setShotUrl(null);
    setItems(null);
    setError(null);
    setEditing(null);
    setGrouped(false);
    setGroupName("");
    setToHistory(true);
    setUnreadable(false);
  };

  const logAll = async () => {
    if (!items?.length) return;
    const repo = await getRepository();
    const exclude = toHistory ? {} : { excludeFromQuickAdd: true };
    if (grouped) {
      const one = groupItems(items, groupName);
      if (one) await repo.addDiaryEntry({ date, meal, quantity: 1, food: one, ...exclude });
    } else {
      for (const food of items) {
        await repo.addDiaryEntry({ date, meal, quantity: 1, food, ...exclude });
      }
    }
    onLogged();
  };

  return (
    <div className="mode-body">
      <div className="segmented" role="tablist">
        {(["text", "photo"] as AiTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`segmented-btn${tab === t ? " active" : ""}`}
            onClick={() => {
              setTab(t);
              retake();
            }}
          >
            {t === "photo" ? "Scan Food/Meal" : "Describe to AI"}
          </button>
        ))}
      </div>

      {tab === "photo" ? (
        shotUrl ? (
          <div className="ai-shot">
            <img className="ai-shot-img" src={shotUrl} alt="Your meal" />
            <button className="link-btn" onClick={retake}>
              Retake photo
            </button>
          </div>
        ) : (
          <CameraCapture
            guide="Point at your plate or the item and tap the shutter."
            onCapture={onCapture}
          />
        )
      ) : (
        <>
          <textarea
            className="text-area"
            rows={3}
            placeholder="Describe what you ate, e.g. 'chicken sandwich and a beer'"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row gap">
            <button className="btn" disabled={busy || !text.trim()} onClick={() => run({ text })}>
              {busy ? "Estimating…" : "Estimate"}
            </button>
          </div>
        </>
      )}

      {busy && tab === "photo" && <div className="muted small">Reading your photo…</div>}
      {error && <div className="notice notice-error">{error}</div>}

      {unreadable && (
        <div className="notice notice-error">
          <div>The estimator didn’t send back an answer this time.</div>
          <div className="muted small">
            Nothing wrong with what you wrote — this is on our side. It usually works on a
            second try.
          </div>
          {lastInput && (
            <button className="btn" disabled={busy} onClick={() => run(lastInput)}>
              Try again
            </button>
          )}
        </div>
      )}

      {items && items.length === 0 && !error && (
        <div className="notice">
          {tab === "photo"
            ? "No foods recognized in that photo. Try a clearer shot, or describe it instead."
            : "No foods recognized in that description. Try naming the dishes, e.g. “turkey sandwich and an apple.”"}
        </div>
      )}

      {items && items.length > 0 && (
        <>
          <div className="ai-toggles">
            <ToggleRow
              label="Log as one item"
              hint={
                grouped
                  ? "Saved as a single entry with the totals added up."
                  : `Saved as ${items.length} separate ${items.length === 1 ? "entry" : "entries"}.`
              }
              on={grouped}
              onChange={setGrouped}
            />
            {grouped && (
              <label className="field group-name-field">
                <span>Name</span>
                <input
                  className="text-input"
                  aria-label="Grouped name"
                  maxLength={40}
                  value={groupName}
                  placeholder={suggestGroupName(items)}
                  onChange={(e) => setGroupName(e.target.value)}
                />
              </label>
            )}
            <ToggleRow
              label="Save to Quick add"
              hint={
                toHistory
                  ? "Appears under Quick add on this meal for one-tap re-logging."
                  : "Won\u2019t appear under Quick add. Still logged, still counts towards your day."
              }
              on={toHistory}
              onChange={setToHistory}
            />
          </div>

          <div className="muted small">
            {grouped
              ? "Estimates — tap an item to edit or delete what isn’t yours before grouping."
              : "Estimates — tap an item to edit or delete what isn’t yours."}
          </div>
          <ul className="parsed-list">
            {items.map((f, i) => (
              <li className="parsed editable" key={f.id}>
                <button className="parsed-main" onClick={() => setEditing(i)}>
                  <span className="entry-name">{f.name}</span>
                  <span className="entry-sub">
                    ~{f.perServing.calories} cal · {f.servingSize}
                  </span>
                </button>
                <button
                  className="parsed-edit icon-btn"
                  aria-label={`Edit ${f.name}`}
                  onClick={() => setEditing(i)}
                >
                  <EditIcon size={18} />
                </button>
              </li>
            ))}
          </ul>
          <button className="btn primary block" onClick={logAll}>
            {grouped
              ? `Log “${(groupName.trim() || suggestGroupName(items)).slice(0, 30)}” to ${MEAL_LABELS[meal]}`
              : `Log ${items.length} item${items.length === 1 ? "" : "s"} to ${MEAL_LABELS[meal]}`}
          </button>
        </>
      )}

      {items && editing != null && items[editing] && (
        <MealItemEditor
          item={items[editing]!}
          onSave={(food) => {
            replaceItem(editing, food);
            setEditing(null);
          }}
          onDelete={() => {
            removeItem(editing);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Modal editor for one AI-estimated meal item (name, serving, per-serving
 *  macros) on the review screen — matches the diary entry editor. Save updates
 *  the item; Delete removes it; both close the modal. */
function MealItemEditor({
  item,
  onSave,
  onDelete,
  onCancel,
}: {
  item: FoodItem;
  onSave: (food: FoodItem) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [serving, setServing] = useState(item.servingSize);
  const [cal, setCal] = useState(item.perServing.calories);
  const [protein, setProtein] = useState(item.perServing.protein);
  const [carbs, setCarbs] = useState(item.perServing.carbs);
  const [fat, setFat] = useState(item.perServing.fat);
  useScrollLock();

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      ...item,
      name: trimmed.slice(0, 80),
      servingSize: serving.trim() || item.servingSize,
      perServing: {
        calories: Math.max(0, Math.round(cal)),
        protein: Math.max(0, Math.round(protein)),
        carbs: Math.max(0, Math.round(carbs)),
        fat: Math.max(0, Math.round(fat)),
      },
    });
  };

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet entry-edit" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Edit item</h2>
          <button className="link-btn" onClick={onCancel}>
            Cancel
          </button>
        </header>
        <div className="sheet-body">
          <label className="field">
            <span>Name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Food name" />
          </label>
          <label className="field">
            <span>Serving</span>
            <input
              className="text-input"
              value={serving}
              onChange={(e) => setServing(e.target.value)}
              placeholder="e.g. 1 cup (240 g)"
            />
          </label>
          <div className="macros-edit-row">
            <NumBox label="Calories" value={cal} onChange={setCal} />
            <NumBox label="Protein (g)" value={protein} onChange={setProtein} />
            <NumBox label="Carbs (g)" value={carbs} onChange={setCarbs} />
            <NumBox label="Fat (g)" value={fat} onChange={setFat} />
          </div>
          <div className="muted small">Macros are per one serving.</div>
        </div>
        <footer className="sheet-foot entry-edit-foot">
          <button className="btn danger" onClick={onDelete}>
            <TrashIcon size={16} /> Delete
          </button>
          <button className="btn primary" disabled={name.trim().length < 1} onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function NumBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="macro-edit plain">
      <span className="macro-edit-label">{label}</span>
      <input
        className="macro-edit-input"
        aria-label={label}
        inputMode="decimal"
        type="text"
        value={value === 0 ? "" : String(value)}
        placeholder="0"
        onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
      />
    </label>
  );
}

// ── Shared: result list + log panel ──────────────────────────────────────

function FoodResultList({
  foods,
  onPick,
  emptyHint,
}: {
  foods: FoodItem[];
  onPick: (food: FoodItem) => void;
  emptyHint: string;
}) {
  if (foods.length === 0) return <div className="muted small">{emptyHint}</div>;
  return (
    <ul className="food-results">
      {foods.map((f, i) => (
        <li key={`${f.source}-${f.id}-${i}`}>
          <button className="food-result" onClick={() => onPick(f)}>
            <div className="entry-main">
              <div className="entry-name">{f.name}</div>
              <div className="entry-sub">
                {f.servingSize}
                {f.brand ? ` · ${f.brand}` : ""} ·{" "}
                {f.source === "usda" ? "USDA" : f.source === "custom" ? "Yours" : "OFF"}
              </div>
            </div>
            <div className="entry-cal">{f.perServing.calories}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function LogPanel({
  food,
  recipeSlug,
  initialQty,
  date,
  defaultMeal,
  onLogged,
  onBack,
  onFix,
  units,
}: {
  food: FoodItem;
  recipeSlug?: string;
  initialQty: number;
  units: Profile["units"];
  date: string;
  defaultMeal: MealType;
  onLogged: () => void;
  onBack: () => void;
  /** The user says these numbers are wrong. */
  onFix: () => void;
}) {
  // `amount` is what the user typed, in `unit`; `q` is the serving multiplier
  // the diary stores. They differ only when a gram weight lets the user say
  // "8 fl oz" instead of "2.37 servings of 100 g" (ConjureOS #475).
  const [unit, setUnit] = useState<AmountUnit>("serving");
  const [qty, setQty] = useState<number | undefined>(initialQty);
  const [meal, setMeal] = useState<MealType>(defaultMeal);
  const [busy, setBusy] = useState(false);
  // Symptoms sit beside food in the same Journal, so they can be noted from
  // here without leaving the food being added (ConjureOS #619).
  const [symptomOpen, setSymptomOpen] = useState(false);
  const [symptomSaved, setSymptomSaved] = useState(false);
  const unitOptions = unitsFor(food, units);
  const step = stepFor(unit);
  const inServings = unit === "serving";

  // A cleared field reads as 0 here (honest preview) and blocks Add below,
  // rather than silently substituting the minimum.
  const q = toServings(qty ?? 0, unit, food);

  const changeUnit = (next: AmountUnit) => {
    // Keep the same amount of food, restated in the new unit.
    setQty(fromServings(q, next, food));
    setUnit(next);
  };
  const cal = Math.round(food.perServing.calories * q);

  const log = async () => {
    if (!qty || qty <= 0) return;
    setBusy(true);
    try {
      const repo = await getRepository();
      await repo.addDiaryEntry({
        date,
        meal,
        // A typed weight is kept to the gram, so it gets a finer floor and
        // precision than the serving stepper.
        quantity: inServings
          ? Math.max(MIN_QTY, Math.round(q * 100) / 100)
          : Math.max(0.001, Math.round(q * 1000) / 1000),
        food,
      });
      if (recipeSlug) await markCooked(recipeSlug);
      onLogged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="log-panel">
      <button className="link-btn back-link" onClick={onBack}>
        <ChevronLeft size={16} /> Back
      </button>
      <h2 className="log-title">{food.name}</h2>
      {food.brand && <div className="muted">{food.brand}</div>}

      <div className="log-macros">
        <Macro label="Cal" value={cal} />
        <Macro label="P" value={Math.round(food.perServing.protein * q)} unit="g" />
        <Macro label="C" value={Math.round(food.perServing.carbs * q)} unit="g" />
        <Macro label="F" value={Math.round(food.perServing.fat * q)} unit="g" />
      </div>

      <label className="field">
        <span>{inServings ? `Servings (${food.servingSize})` : `Amount (1 serving is ${food.servingSize})`}</span>
        <div className="qty-stepper">
          <button
            className="step"
            onClick={() =>
              setQty((v) => Math.max(inServings ? MIN_QTY : step, Math.round(((v ?? 0) - step) / step) * step))
            }
          >
            −
          </button>
          {/* Same reason as the edit modal: clamping to the min on every
              keystroke made a typed "0.5" collapse to the floor mid-entry. */}
          <NumberField
            className="qty-input"
            value={qty}
            onChange={setQty}
            min={inServings ? MIN_QTY : 0}
            max={inServings ? 99 : 9999}
            decimals={2}
            aria-label={inServings ? "Servings" : `Amount in ${UNIT_LABELS[unit]}`}
          />
          <button className="step" onClick={() => setQty((v) => Math.round(((v ?? 0) + step) / step) * step)}>
            +
          </button>
          {unitOptions.length > 1 && (
            <select
              className="select qty-unit"
              aria-label="Unit"
              value={unit}
              onChange={(e) => changeUnit(e.target.value as AmountUnit)}
            >
              {unitOptions.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          )}
        </div>
        {isVolume(unit) && (
          <span className="muted small">Volume is converted as if it weighs the same as water.</span>
        )}
      </label>

      <label className="field">
        <span>Meal</span>
        <MealPicker meal={meal} onChange={setMeal} />
      </label>

      <button className="btn primary block" disabled={busy || !qty || qty <= 0} onClick={log}>
        {busy ? "Adding…" : `Add to ${MEAL_LABELS[meal]}`}
      </button>

      {/* Always here, in the same spot. We do not judge the numbers ourselves
          — the person holding the package is the one who can tell. */}
      <button className="btn log-report" onClick={onFix}>
        Looks wrong?
      </button>

      <button className="btn log-report" onClick={() => setSymptomOpen(true)}>
        {symptomSaved ? "Symptom saved. Add another?" : "Log how you felt"}
      </button>

      {symptomOpen && (
        <SymptomSheet
          date={date}
          onClose={() => setSymptomOpen(false)}
          onSaved={() => {
            setSymptomOpen(false);
            setSymptomSaved(true);
          }}
        />
      )}
    </div>
  );
}

// ── "Looks wrong" correction flow ────────────────────────────────────────

/**
 * What to do about a food whose numbers are wrong: type the label in, or snap
 * a photo and let the parser do it.
 *
 * Both paths end at the same review screen the AI parses use, and both end with
 * the corrected food handed back to `onFixed` — which stores it locally and
 * submits it to the community DB. The user's diary never waits on that submit.
 */
function FixFlow({
  food,
  onFixed,
  onCancel,
}: {
  food: FoodItem;
  onFixed: (food: FoodItem) => void;
  onCancel: () => void;
}) {
  const [stage, setStage] = useState<"choose" | "manual" | "photo">("choose");
  const [parsed, setParsed] = useState<PendingPreview | null>(null);

  if (parsed) {
    return (
      <EditableNutritionPreview
        initial={{ ...parsed.food, barcode: parsed.food.barcode ?? food.barcode }}
        source={parsed.source}
        aiConfidence={parsed.confidence}
        warningNote={parsed.warningNote}
        onConfirm={onFixed}
        onCancel={() => setParsed(null)}
      />
    );
  }

  if (stage === "manual") {
    return (
      <EditableNutritionPreview
        initial={food}
        source="user_fix"
        onConfirm={onFixed}
        onCancel={() => setStage("choose")}
      />
    );
  }

  if (stage === "photo") {
    return (
      <PackageCapture
        barcode={food.barcode}
        onParsed={(res: PackageResult) =>
          setParsed({
            food: res.food,
            source: res.source,
            confidence: res.confidence,
            ...(res.warningNote ? { warningNote: res.warningNote } : {}),
          })
        }
        onCancel={() => setStage("choose")}
      />
    );
  }

  return (
    <div className="mode-body snap-miss">
      <div className="snap-miss-copy">
        <div>What's wrong with {food.name}?</div>
        <div className="muted small">
          Tell us the right numbers and we'll use yours from now on.
        </div>
      </div>

      <button className="snap-cta-card primary" onClick={() => setStage("photo")}>
        <span className="snap-cta-icon">
          <NutritionPanelIcon size={26} />
        </span>
        <span className="snap-cta-text">
          <span className="snap-cta-title">Photograph the package</span>
          <span className="snap-cta-sub">The nutrition panel, the front, or both.</span>
        </span>
        <ChevronRight size={20} />
      </button>

      <button className="snap-cta-card secondary" onClick={() => setStage("manual")}>
        <span className="snap-cta-icon">
          <EditIcon size={26} />
        </span>
        <span className="snap-cta-text">
          <span className="snap-cta-title">Type in the right numbers</span>
          <span className="snap-cta-sub">Straight off the nutrition label, no photo needed.</span>
        </span>
        <ChevronRight size={20} />
      </button>

      <button className="link-btn" onClick={onCancel}>
        Never mind
      </button>
    </div>
  );
}

function MealPicker({ meal, onChange }: { meal: MealType; onChange: (m: MealType) => void }) {
  return (
    <select className="select" value={meal} onChange={(e) => onChange(e.target.value as MealType)}>
      {MEAL_TYPES.map((m) => (
        <option key={m} value={m}>
          {MEAL_LABELS[m]}
        </option>
      ))}
    </select>
  );
}

function Macro({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div className="macro-pill">
      <div className="macro-pill-value">
        {value}
        {unit ?? ""}
      </div>
      <div className="macro-pill-label">{label}</div>
    </div>
  );
}

// ── "Add your own food" ─────────────────────────────────────────────────

/**
 * A food typed in by hand: name, one serving (amount plus unit), calories and
 * macros. Free; it saves to the app's VFS and is searchable afterwards. The AI
 * estimate is a separate, paid path under the AI tab.
 */
function CustomFoodForm({
  initialName,
  onSaved,
  onCancel,
}: {
  initialName: string;
  onSaved: (food: FoodItem) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [brand, setBrand] = useState("");
  const [amount, setAmount] = useState<number | undefined>(1);
  const [unit, setUnit] = useState<string>("serving");
  const [calories, setCalories] = useState<number | undefined>(undefined);
  const [protein, setProtein] = useState<number | undefined>(undefined);
  const [carbs, setCarbs] = useState<number | undefined>(undefined);
  const [fat, setFat] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const input = {
    name,
    brand,
    servingAmount: amount ?? 0,
    servingUnit: unit,
    calories: calories ?? NaN,
    protein: protein ?? 0,
    carbs: carbs ?? 0,
    fat: fat ?? 0,
  };
  const problem = customFoodProblem(input);

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      const food = await saveCustomFood(input);
      if (food) onSaved(food);
    } finally {
      setBusy(false);
    }
  };

  const macro = (label: string, value: number | undefined, set: (v: number | undefined) => void) => (
    <label className="field">
      <span>{label}</span>
      <NumberField value={value} onChange={set} min={0} max={9999} decimals={1} aria-label={label} />
    </label>
  );

  return (
    <div className="log-panel custom-food-form">
      <button className="link-btn back-link" onClick={onCancel}>
        <ChevronLeft size={16} /> Back
      </button>
      <h2 className="log-title">Add your own food</h2>
      <div className="muted small">Copy the numbers off the label. Saved foods show up when you search.</div>

      <label className="field">
        <span>Name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Brand (optional)</span>
        <input className="text-input" value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Serving</span>
          <NumberField value={amount} onChange={setAmount} min={0} max={9999} decimals={2} aria-label="Serving amount" />
        </label>
        <label className="field">
          <span>Unit</span>
          <select className="select" aria-label="Serving unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
            {CUSTOM_SERVING_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>

      {macro("Calories per serving", calories, setCalories)}
      <div className="field-row">
        {macro("Protein (g)", protein, setProtein)}
        {macro("Carbs (g)", carbs, setCarbs)}
        {macro("Fat (g)", fat, setFat)}
      </div>

      {problem && <div className="muted small">{problem}</div>}
      <button className="btn primary block" disabled={!!problem || busy} onClick={save}>
        {busy ? "Saving…" : "Save food"}
      </button>
    </div>
  );
}
