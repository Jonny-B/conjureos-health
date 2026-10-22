import { useEffect, useRef, useState } from "react";
import type { DiaryEntry, FoodItem, Goals, Macros, MealType, Profile } from "../types";
import {
  fromServings,
  isVolume,
  servingRatio,
  toServings,
  unitsFor,
  UNIT_LABELS,
  type AmountUnit,
} from "../features/servingUnits";
import { parseServingGrams } from "../features/foods/serving";
import { MEAL_LABELS, MEAL_TYPES } from "../types";
import { getRepository } from "../data/repository";
import { entryMacros, isAiEstimate } from "../features/diary";
import { recentFoodsForMeal, type RecentFood } from "../features/recentFoods";
import { groupEntries, suggestGroupName } from "../features/grouping";
import { BarcodeIcon, CheckIcon, DiamondIcon, EditIcon, SearchIcon, TrashIcon } from "../components/icons";
import { AiEstimateBadge } from "../components/AiEstimateBadge";
import { useScrollLock } from "../hooks/useScrollLock";
import { NumberField } from "../components/NumberField";

interface Props {
  date: string;
  meal: MealType;
  goals: Goals;
  nonce: number;
  onScan: () => void;
  onSearch: () => void;
  onAi: () => void;
  onMutated: () => void;
  /** Display preference; orders the amount-unit picker in the edit sheet. */
  units?: Profile["units"];
}

/**
 * A single meal's detail: everything already logged to it (each row editable
 * via the quantity steppers and removable via the trash), and the three ways to
 * add more — Scan Barcode, Search, or AI. The page title + back live in the
 * global header; this screen shows only the running subtotal.
 *
 * This sits between the Diary and the Add screen so tapping "Lunch" shows what
 * you've eaten first, instead of dropping straight into a blank search.
 */
/** Smallest loggable portion. Also the floor the +/- steppers stop at. */
export const MIN_QTY = 0.1;

/** How far back the quick-add list looks, and how many rows it shows. Short on
 *  purpose — this is a scannable shortcut list, not an archive. */
const HISTORY_DAYS = 7;
const HISTORY_LIMIT = 10;

export function MealDetailScreen({
  date,
  meal,
  nonce,
  onScan,
  onSearch,
  onAi,
  onMutated,
  units = "metric",
}: Props) {
  const [entries, setEntries] = useState<DiaryEntry[] | null>(null);
  // The entry currently open in the edit modal, or null.
  const [editing, setEditing] = useState<DiaryEntry | null>(null);
  // Multi-select mode for collapsing several logged foods into one saved group.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const repo = await getRepository();
      const all = await repo.listDiary(date);
      if (alive) setEntries(all.filter((e) => e.meal === meal));
    })();
    return () => {
      alive = false;
    };
  }, [date, meal, nonce]);

  const updateQty = async (entry: DiaryEntry, delta: number) => {
    const next = Math.round((entry.quantity + delta) * 4) / 4; // 0.25 steps
    if (next < 0.25) return;
    const repo = await getRepository();
    await repo.updateDiaryEntry(entry.id, { quantity: next });
    onMutated();
  };

  const list = entries ?? [];
  const total = list.reduce((sum, e) => sum + entryMacros(e).calories, 0);

  const selected = list.filter((e) => picked.has(e.id));
  const exitSelect = () => {
    setSelecting(false);
    setPicked(new Set());
  };

  return (
    <div className="meal-detail">
      <div className="meal-detail-subhead">
        <span className="meal-detail-cal">
          {selecting ? `${selected.length} selected` : `${total} cal logged`}
        </span>
        {list.length >= 2 &&
          (selecting ? (
            <button className="link-btn" onClick={exitSelect}>
              Cancel
            </button>
          ) : (
            <button className="link-btn" onClick={() => setSelecting(true)}>
              Group foods
            </button>
          ))}
      </div>

      {entries === null ? (
        <div className="center-fill">
          <div className="spinner" />
        </div>
      ) : list.length === 0 ? (
        <p className="meal-detail-empty muted">
          Nothing logged to {MEAL_LABELS[meal].toLowerCase()} yet.
        </p>
      ) : (
        <ul className="entry-list">
          {list.map((e) => {
            const em = entryMacros(e);
            return (
              <li className={`entry${selecting ? " selectable" : ""}`} key={e.id}>
                {selecting && (
                  <button
                    className={`entry-check${picked.has(e.id) ? " on" : ""}`}
                    role="checkbox"
                    aria-checked={picked.has(e.id)}
                    aria-label={`Select ${e.food.name}`}
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(e.id)) next.delete(e.id);
                        else next.add(e.id);
                        return next;
                      })
                    }
                  >
                    {picked.has(e.id) ? <CheckIcon size={14} /> : null}
                  </button>
                )}
                <div className="entry-main">
                  <div className="entry-title">
                    <span className="entry-name">{e.food.name}</span>
                    {isAiEstimate(e) && <AiEstimateBadge />}
                  </div>
                  <div className="entry-sub">
                    {e.quantity}× {e.food.servingSize}
                    {e.food.brand ? ` · ${e.food.brand}` : ""}
                  </div>
                </div>
                <div className="entry-cal">{em.calories}</div>
                <div className="entry-actions" hidden={selecting}>
                  <button
                    className="step"
                    aria-label="Less"
                    disabled={e.quantity <= 0.25}
                    onClick={() => updateQty(e, -0.25)}
                  >
                    −
                  </button>
                  <button className="step" aria-label="More" onClick={() => updateQty(e, 0.25)}>
                    +
                  </button>
                  <button className="step" aria-label="Edit" onClick={() => setEditing(e)}>
                    <EditIcon size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {selecting ? (
        <div className="group-bar">
          <span className="muted small">
            {selected.length < 2
              ? "Pick two or more to group them."
              : `Combine ${selected.length} into one saved food.`}
          </span>
          <button className="btn primary" disabled={selected.length < 2} onClick={() => setNaming(true)}>
            Group
          </button>
        </div>
      ) : (
      <div className="meal-cta-row three">
        <button className="meal-cta" onClick={onScan}>
          <BarcodeIcon size={22} />
          <span>Scan Barcode</span>
        </button>
        <button className="meal-cta" onClick={onAi}>
          <DiamondIcon size={20} />
          <span>AI</span>
        </button>
        <button className="meal-cta" onClick={onSearch}>
          <SearchIcon size={20} />
          <span>Search</span>
        </button>
      </div>
      )}

      {!selecting && <MealHistory meal={meal} date={date} nonce={nonce} onLogged={onMutated} />}

      {naming && (
        <GroupNameSheet
          entries={selected}
          onCancel={() => setNaming(false)}
          onDone={async (name: string) => {
            const food = groupEntries(selected, name);
            if (!food) return;
            const repo = await getRepository();
            // Replace, not add: the parts collapse INTO the group, so the meal
            // total is unchanged and the diary doesn't double-count.
            await repo.addDiaryEntry({ date, meal, quantity: 1, food });
            for (const e of selected) await repo.removeDiaryEntry(e.id);
            setNaming(false);
            exitSelect();
            onMutated();
          }}
        />
      )}

      {editing && (
        <EntryEditModal
          entry={editing}
          units={units}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onMutated();
          }}
        />
      )}
    </div>
  );
}

/**
 * Name the group, then collapse.
 *
 * Prefilled with a derived name so Enter alone is a complete answer — the
 * point of this flow is that a smoothie you make constantly stops costing
 * three scans, and making someone think of a name first would be a new bit of
 * friction in place of the old one.
 *
 * It lists what is about to be combined because the action is destructive in a
 * quiet way: the parts stop existing as separate rows, and the totals need to
 * be recognisably the same afterwards.
 */
function GroupNameSheet({
  entries,
  onCancel,
  onDone,
}: {
  entries: DiaryEntry[];
  onCancel: () => void;
  onDone: (name: string) => void | Promise<void>;
}) {
  useScrollLock();
  const suggestion = suggestGroupName(entries.map((e) => e.food));
  const [name, setName] = useState(suggestion);
  const [busy, setBusy] = useState(false);

  const totals = entries.reduce(
    (sum, e) => sum + entryMacros(e).calories,
    0,
  );

  const submit = async () => {
    const text = name.trim() || suggestion;
    if (!text || busy) return;
    setBusy(true);
    try {
      await onDone(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Name this group" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Name this group</h2>
        </div>
        <div className="sheet-body">
          <label className="field">
            <span>Name</span>
            <input
              className="text-input"
              autoFocus
              maxLength={40}
              aria-label="Group name"
              value={name}
              placeholder={suggestion}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </label>

          <div className="section-label">Combining</div>
          <ul className="group-preview">
            {entries.map((e) => (
              <li key={e.id}>
                <span>
                  {e.quantity !== 1 ? `${e.quantity}\u00d7 ` : ""}
                  {e.food.name}
                </span>
                <span className="muted">{entryMacros(e).calories}</span>
              </li>
            ))}
            <li className="group-preview-total">
              <span>Total</span>
              <span>{totals} cal</span>
            </li>
          </ul>
          <div className="muted small">
            These rows are replaced by one entry. Your day\u2019s total doesn\u2019t change, and the
            group shows up in this meal\u2019s quick-add list.
          </div>
        </div>
        <div className="sheet-foot">
          <button className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "Grouping\u2026" : "Group"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What you last put in this meal, over the past week.
 *
 * Sits under the add buttons rather than above them: it's a shortcut for the
 * common case, not the primary action, and someone who wants something new
 * shouldn't have to scroll past a week of breakfasts to reach Search.
 *
 * A week rather than the 30 days the search screen uses — this list is meant
 * to stay short enough to scan, and what you ate last Tuesday is a better
 * suggestion than what you ate a month ago.
 */
function MealHistory({
  meal,
  date,
  nonce,
  onLogged,
}: {
  meal: MealType;
  date: string;
  nonce: number;
  onLogged: () => void;
}) {
  const [recents, setRecents] = useState<RecentFood[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    recentFoodsForMeal(meal, { days: HISTORY_DAYS, limit: HISTORY_LIMIT })
      .then((r) => {
        if (alive) setRecents(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meal, nonce]);

  if (recents.length === 0) return null;

  const relog = async (r: RecentFood) => {
    const key = `${r.food.name}-${r.lastLoggedAt}`;
    if (busy) return;
    setBusy(key);
    try {
      const repo = await getRepository();
      await repo.addDiaryEntry({ date, meal, quantity: r.quantity, food: r.food });
      onLogged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="meal-history">
      <div className="section-label">Quick add</div>
      <ul className="history-list">
        {recents.map((r) => {
          const key = `${r.food.name}-${r.lastLoggedAt}`;
          const cal = Math.round(r.food.perServing.calories * r.quantity);
          return (
            <li key={key}>
              <button className="history-item" disabled={busy !== null} onClick={() => relog(r)}>
                <span className="history-body">
                  <span className="entry-name">{r.food.name}</span>
                  <span className="entry-sub">
                    {r.quantity !== 1 ? `${r.quantity}\u00d7 ` : ""}
                    {r.food.servingSize}
                    {r.food.brand ? ` \u00b7 ${r.food.brand}` : ""}
                  </span>
                </span>
                <span className="history-cal">{cal}</span>
                <span className="history-add" aria-hidden>
                  +
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Edit a logged diary entry: fix the name/serving/macros, change how much, MOVE
 * it to a different meal, or delete it. Edits patch the entry's food snapshot
 * (per-serving macros) + meal + quantity in one save.
 *
 * Numbers follow the amount (ConjureOS #644): changing the serving label to a
 * comparable one ("100 g" to "150 g", "1 cup" to "2 cups") rescales the
 * per-serving macros, and the entry's total is shown live as the amount or unit
 * changes. Typing a macro by hand makes that the new baseline.
 */
function EntryEditModal({
  entry,
  units,
  onClose,
  onSaved,
}: {
  entry: DiaryEntry;
  units: Profile["units"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(entry.food.name);
  const [serving, setServing] = useState(entry.food.servingSize);
  const [servingGrams, setServingGrams] = useState<number | undefined>(
    entry.food.servingGrams ?? parseServingGrams(entry.food.servingSize) ?? undefined,
  );
  const [meal, setMeal] = useState<MealType>(entry.meal);
  // `qty` is what the user typed, in `unit`; the diary stores servings.
  const [unit, setUnit] = useState<AmountUnit>("serving");
  const [qty, setQty] = useState<number | undefined>(entry.quantity);
  const [macros, setMacros] = useState<Macros>({ ...entry.food.perServing });
  // What a serving-label change scales from: the label and numbers as they
  // were before the user started retyping the label.
  const base = useRef({ serving: entry.food.servingSize, grams: servingGrams, macros: { ...entry.food.perServing } });
  const [busy, setBusy] = useState(false);
  // A thrown write (transient backend hiccup) used to leave `busy` stuck
  // true forever, since save()/remove() had no catch — Save and Delete
  // stayed disabled with nothing on screen to explain why, and Cancel (the
  // only live control) discards the edit instead of letting you retry it.
  const [error, setError] = useState<string | null>(null);
  useScrollLock();

  const sizing: FoodItem = { ...entry.food, servingGrams };
  const unitOptions = unitsFor(sizing, units);
  const inServings = unit === "serving";
  const q = toServings(qty ?? 0, unit, sizing);

  const changeServing = (next: string) => {
    setServing(next);
    const b = base.current;
    const ratio = servingRatio(b.serving, next, b.grams, parseServingGrams);
    const nextGrams = parseServingGrams(next) ?? (ratio && b.grams ? b.grams * ratio : undefined);
    setServingGrams(nextGrams ?? (next.trim() === b.serving.trim() ? b.grams : undefined));
    if (ratio) {
      const r1 = (v: number) => Math.round(v * ratio * 10) / 10;
      setMacros({
        ...b.macros,
        calories: r1(b.macros.calories),
        protein: r1(b.macros.protein),
        carbs: r1(b.macros.carbs),
        fat: r1(b.macros.fat),
      });
    } else if (next.trim() === b.serving.trim()) {
      setMacros({ ...b.macros });
    }
  };

  const setMacro = (k: "calories" | "protein" | "carbs" | "fat") => (v: number) => {
    const m = { ...macros, [k]: v };
    setMacros(m);
    // A hand-typed number is the truth for the label as it reads now.
    base.current = { serving, grams: servingGrams, macros: m };
  };

  const changeUnit = (next: AmountUnit) => {
    setQty(fromServings(q, next, sizing));
    setUnit(next);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const food: FoodItem = {
      ...entry.food,
      name: trimmed.slice(0, 80),
      servingSize: serving.trim() || entry.food.servingSize,
      ...(servingGrams ? { servingGrams: Math.round(servingGrams * 10) / 10 } : {}),
      perServing: {
        ...macros,
        calories: Math.max(0, Math.round(macros.calories)),
        protein: Math.max(0, Math.round(macros.protein)),
        carbs: Math.max(0, Math.round(macros.carbs)),
        fat: Math.max(0, Math.round(macros.fat)),
      },
    };
    if (!servingGrams) delete food.servingGrams;
    try {
      const repo = await getRepository();
      await repo.updateDiaryEntry(entry.id, {
        food,
        meal,
        // 2dp, not quarters: the steppers move in 0.25s but a TYPED 0.3 or 1.75
        // should survive the save rather than snapping to the nearest quarter.
        // A typed weight keeps gram precision instead.
        quantity: inServings
          ? Math.max(MIN_QTY, Math.round((qty ?? MIN_QTY) * 100) / 100)
          : Math.max(0.001, Math.round(q * 1000) / 1000),
      });
      onSaved();
    } catch {
      setError("Couldn't save. Try again.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await getRepository();
      await repo.removeDiaryEntry(entry.id);
      onSaved();
    } catch {
      setError("Couldn't delete. Try again.");
      setBusy(false);
    }
  };

  const total = (v: number) => Math.round(v * q);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet entry-edit" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2>Edit item</h2>
          <button className="link-btn" onClick={onClose}>
            Cancel
          </button>
        </header>

        <div className="sheet-body">
          <label className="field">
            <span>Name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Food name" />
          </label>

          <label className="field">
            <span>Meal</span>
            <select className="select" value={meal} onChange={(e) => setMeal(e.target.value as MealType)}>
              {MEAL_TYPES.map((m) => (
                <option key={m} value={m}>
                  {MEAL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{inServings ? "Amount (servings)" : `Amount (1 serving is ${serving || entry.food.servingSize})`}</span>
            <div className="qty-stepper">
              {/* NumberField, not a raw input: a controlled `String(Number(v))`
                  field erases the trailing dot the instant you type "0.", so a
                  decimal quantity could never be entered. */}
              <NumberField
                className="qty-input"
                value={qty}
                onChange={setQty}
                min={inServings ? MIN_QTY : 0}
                max={inServings ? 99 : 9999}
                decimals={2}
                aria-label={inServings ? "Quantity (servings)" : `Amount in ${UNIT_LABELS[unit]}`}
              />
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
            <span>Serving</span>
            <input
              className="text-input"
              value={serving}
              onChange={(e) => changeServing(e.target.value)}
              placeholder="e.g. 1 cup (240 g)"
            />
          </label>

          <div className="macros-edit-row">
            <MacroBox label="Calories" value={macros.calories} onChange={setMacro("calories")} />
            <MacroBox label="Protein (g)" value={macros.protein} onChange={setMacro("protein")} />
            <MacroBox label="Carbs (g)" value={macros.carbs} onChange={setMacro("carbs")} />
            <MacroBox label="Fat (g)" value={macros.fat} onChange={setMacro("fat")} />
          </div>
          <div className="muted small">
            Per serving. Changing the serving to a weight or count, like 150 g or 2 cups, rescales them.
          </div>
          <div className="entry-edit-total" aria-live="polite">
            This entry: <strong>{total(macros.calories)} cal</strong> · {total(macros.protein)} g protein ·{" "}
            {total(macros.carbs)} g carbs · {total(macros.fat)} g fat
          </div>
          {error && <div className="notice notice-error">{error}</div>}
        </div>

        <footer className="sheet-foot entry-edit-foot">
          <button className="btn danger" disabled={busy} onClick={remove}>
            <TrashIcon size={16} /> Delete
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !(q > 0)} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function MacroBox({
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
