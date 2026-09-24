/**
 * Edit or delete one thing on the journal timeline.
 *
 * One sheet rather than five, because the shapes are small and the action is
 * always the same — "this is wrong, fix it or bin it". The fields differ per
 * kind; delete is universal, since the most common correction is "that
 * shouldn't be there at all".
 *
 * A weigh-in and a workout only offer delete: the weight belongs to the weight
 * card and a session to the exercise screen, and duplicating those editors
 * here would be two places to keep in step for no gain.
 */

import { useState } from "react";
import type { JournalEvent } from "../features/journal";
import type { MealType } from "../types";
import { MEAL_LABELS, MEAL_TYPES } from "../types";
import { getRepository } from "../data/repository";
import { reportSaveFailure } from "../data/saveFailure";
import { removeSession } from "../features/exercise";
import { flOzToMl, mlToFlOz } from "../features/water";
import type { Profile } from "../types";
import { useScrollLock } from "../hooks/useScrollLock";
import { NumberField } from "./NumberField";
import { CloseIcon } from "./icons";

type Units = Profile["units"];

const SEVERITY = [1, 2, 3, 4, 5];

/**
 * The ml to write for a water edit, or undefined to leave the stored value
 * alone.
 *
 * `amount` starts out as the entry's ALREADY-ROUNDED display string (we only
 * get `fmtWater`'s output, not the true stored ml — see the field below), so
 * re-deriving ml from it via a round-trip conversion is not the identity
 * function: 1000ml displays as "34 oz" and converting that back gives 1005ml.
 * Opening an entry and saving it untouched must be a no-op on disk, so we
 * only ever convert+write when the amount was actually edited; otherwise we
 * omit `ml` from the patch entirely and the repository leaves the existing
 * value exactly as it was, no drift possible.
 */
export function nextWaterMl(
  amount: number | undefined,
  edited: boolean,
  units: Units,
  storedMl?: number,
): number | undefined {
  if (!edited) return undefined;
  if (!amount || amount <= 0) return undefined;
  const next = units === "imperial" ? Math.round(flOzToMl(amount)) : Math.round(amount);
  // The displayed amount is a ROUNDED view of `storedMl`, so re-converting it
  // moves the value even when the user changed nothing meaningful: 250ml shows
  // as "8 oz" and converts back to 237ml. When the number on screen still
  // renders the value already on disk, the user did not actually change the
  // amount — keep what is stored rather than the lossy round-trip of it.
  if (storedMl !== undefined && displaysAs(storedMl, amount, units)) return storedMl;
  return next;
}

/** Whether `stored` (ml) is what produced the amount currently on screen. */
function displaysAs(storedMl: number, shown: number, units: Units): boolean {
  const asShown = units === "imperial" ? mlToFlOz(storedMl) : storedMl;
  return Math.round(asShown) === Math.round(shown);
}

const TITLES: Record<JournalEvent["kind"], string> = {
  food: "Edit food",
  water: "Edit drink",
  symptom: "Edit symptom",
  sleep: "Edit sleep",
  weight: "Weigh-in",
  exercise: "Workout",
};

export function JournalEntrySheet({
  event,
  units,
  onClose,
  onChanged,
}: {
  event: JournalEvent;
  units: Units;
  onClose: () => void;
  /** Fired after a successful save or delete. */
  onChanged: () => void;
}) {
  useScrollLock();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Food
  const [qty, setQty] = useState<number | undefined>(1);
  const [meal, setMeal] = useState<MealType>((event.meal as MealType) ?? "snacks");
  // Water — edited in the user's own units, converted on save.
  // Prefer the entry's TRUE stored value over the rounded display string; the
  // regex fallback only covers events that predate `rawValue`.
  const startAmount =
    event.rawValue !== undefined
      ? units === "imperial"
        ? Math.round(mlToFlOz(event.rawValue))
        : event.rawValue
      : Number(/[\d.]+/.exec(event.detail ?? "")?.[0] ?? 0);
  const [amount, setAmount] = useState<number | undefined>(startAmount || undefined);
  // Whether the user actually touched the amount field. `amount` is seeded
  // from the rounded display string, not the true stored ml, so we must not
  // convert-and-rewrite it on a save unless the user changed it — see
  // `nextWaterMl`.
  const [amountEdited, setAmountEdited] = useState(false);
  // Symptom
  const [label, setLabel] = useState(event.label);
  const [severity, setSeverity] = useState<number | undefined>(
    event.detail ? Number(event.detail.split("/")[0]) || undefined : undefined,
  );
  const [note, setNote] = useState(event.note ?? "");

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const repo = await getRepository();
      if (event.kind === "food") {
        await repo.updateDiaryEntry(event.id, {
          ...(qty && qty > 0 ? { quantity: Math.round(qty * 100) / 100 } : {}),
          meal,
        });
      } else if (event.kind === "water") {
        const ml = nextWaterMl(amount, amountEdited, units, event.rawValue);
        if (ml !== undefined) await repo.updateWater(event.id, { ml });
      } else if (event.kind === "symptom") {
        const text = label.trim();
        if (!text) return;
        await repo.updateSymptom(event.id, {
          label: text,
          severity,
          note: note.trim() || undefined,
        });
      }
      onChanged();
    } catch (err) {
      reportSaveFailure("your changes", err);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const repo = await getRepository();
      switch (event.kind) {
        case "food":
          await repo.removeDiaryEntry(event.id);
          break;
        case "water":
          await repo.removeWater(event.id);
          break;
        case "symptom":
          await repo.removeSymptom(event.id);
          break;
        case "sleep":
          await repo.removeSleep(event.id);
          break;
        case "weight":
          await repo.removeWeight(event.id);
          break;
        case "exercise":
          await removeSession(event.id);
          break;
      }
      onChanged();
    } catch (err) {
      reportSaveFailure("that change", err);
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    (event.kind === "food" && !!qty && qty > 0) ||
    (event.kind === "water" && !!amount && amount > 0) ||
    (event.kind === "symptom" && label.trim().length > 0);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={TITLES[event.kind]} onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{TITLES[event.kind]}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="entry-headline">{event.label}</div>

          {event.kind === "food" && (
            <>
              <label className="field">
                <span>Servings</span>
                <NumberField
                  className="qty-input"
                  value={qty}
                  onChange={setQty}
                  min={0.1}
                  max={99}
                  decimals={2}
                  aria-label="Servings"
                />
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
            </>
          )}

          {event.kind === "water" && (
            <label className="field">
              <span>Amount ({units === "imperial" ? "oz" : "ml"})</span>
              <NumberField
                className="qty-input"
                value={amount}
                onChange={(v) => {
                  setAmount(v);
                  setAmountEdited(true);
                }}
                min={1}
                max={units === "imperial" ? 200 : 5000}
                decimals={0}
                aria-label="Amount"
              />
            </label>
          )}

          {event.kind === "symptom" && (
            <>
              <label className="field">
                <span>What was it?</span>
                <input className="text-input" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <div className="field">
                <span>How bad?</span>
                <div className="wb-chips">
                  {SEVERITY.map((n) => (
                    <button
                      key={n}
                      className={`chip-btn${severity === n ? " active" : ""}`}
                      onClick={() => setSeverity(severity === n ? undefined : n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field">
                <span>Note</span>
                <input className="text-input" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
            </>
          )}

          {event.kind === "sleep" && (
            <div className="muted small">
              Open this day on the Diary tab to change the times. You can remove the night here.
            </div>
          )}
          {event.kind === "weight" && (
            <div className="muted small">
              Weigh-ins are edited from the weight card on the Diary tab. You can remove this one here.
            </div>
          )}
          {event.kind === "exercise" && (
            <div className="muted small">
              {event.editable
                ? "Removing this deletes the session and takes its calories back out of that day."
                : "This came from your watch, so it can't be deleted here — hide it from the day on the Exercise screen."}
            </div>
          )}
        </div>

        <div className="sheet-foot">
          {event.editable && (
            <button
              className={`btn ${confirmDelete ? "danger" : "danger-subtle"}`}
              disabled={busy}
              onClick={() => (confirmDelete ? void del() : setConfirmDelete(true))}
            >
              {confirmDelete ? "Tap to confirm" : "Delete"}
            </button>
          )}
          {canSave && (
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
