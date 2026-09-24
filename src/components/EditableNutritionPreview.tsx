/**
 * Polished editable review screen shown after a label snap, a front-of-package
 * snap, OR a "Looks wrong" correction of a food some provider already gave us.
 * Every macro and micro is correctable before submission. On Save, fires
 * contribute() (best-effort) and hands the (possibly corrected) FoodItem to the
 * parent so LogPanel routes serving + meal next.
 *
 * The three sources differ only in framing: an AI parse needs a "we guessed,
 * check it" warning, a correction needs to say what looked wrong and where the
 * fix goes. The form underneath is identical, so they share one screen.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FoodItem, Micros } from "../types";
import { contribute } from "../features/foods/conjureHealthDb";
import { AlertTriangle, CheckIcon, ChevronLeft, ChevronRight } from "./icons";

/** How the numbers on screen were arrived at. "user_fix" is the user
 *  correcting an existing entry by hand, not an AI parse. */
type ParseSource = "ai_label" | "ai_front" | "user_fix";

interface Props {
  initial: FoodItem;
  source: ParseSource;
  /** Only meaningful for the AI sources. */
  aiConfidence?: number;
  warningNote?: string;
  onConfirm: (food: FoodItem) => void;
  onCancel: () => void;
}

interface SaveState {
  phase: "idle" | "saving" | "failed";
  message?: string;
}

function deepEqualFood(a: FoodItem, b: FoodItem): boolean {
  if (
    a.name !== b.name ||
    a.brand !== b.brand ||
    a.servingSize !== b.servingSize ||
    a.servingGrams !== b.servingGrams
  ) {
    return false;
  }
  for (const k of ["calories", "protein", "carbs", "fat"] as const) {
    if (a.perServing[k] !== b.perServing[k]) return false;
  }
  const am = a.micros ?? {};
  const bm = b.micros ?? {};
  const keys = new Set([...Object.keys(am), ...Object.keys(bm)]) as Set<keyof Micros>;
  for (const k of keys) {
    if (am[k] !== bm[k]) return false;
  }
  return true;
}

/**
 * The review screen for any food whose numbers need a human before they reach
 * the diary — an AI parse, or an existing entry the user says is wrong.
 *
 * On save it contributes the (possibly corrected) food back to the community
 * DB, but that is strictly best-effort: a failed contribution still logs the
 * food locally, since the user's own diary must never depend on our backend.
 */
export function EditableNutritionPreview({
  initial,
  source,
  aiConfidence = 0,
  warningNote,
  onConfirm,
  onCancel,
}: Props) {
  const [food, setFood] = useState<FoodItem>(() => ({
    ...initial,
    micros: { ...(initial.micros ?? {}) },
  }));
  const [moreOpen, setMoreOpen] = useState(false);
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const isFront = source === "ai_front";
  const isFix = source === "user_fix";
  const lowConfidence = !isFix && aiConfidence < 0.4;

  const userEdited = useMemo(() => !deepEqualFood(food, initial), [food, initial]);

  const update = <K extends keyof FoodItem>(k: K, v: FoodItem[K]) =>
    setFood((f) => ({ ...f, [k]: v }));
  const updateMacro = (k: "calories" | "protein" | "carbs" | "fat", v: number) =>
    setFood((f) => ({ ...f, perServing: { ...f.perServing, [k]: Math.max(0, v) } }));
  const updateMicro = (k: keyof Micros, v: number | undefined) =>
    setFood((f) => ({ ...f, micros: { ...(f.micros ?? {}), [k]: v } }));

  const showAlcoholTop = isFront || (food.micros?.alcoholG ?? 0) > 0;

  // The "couldn't share your edit" notice auto-advances after a beat. Track the
  // timer so unmounting (the user hits Back first) cancels it — otherwise it
  // fires onConfirm against a dead screen and logs the food anyway.
  const advanceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);

  const onSave = async () => {
    setSave({ phase: "saving" });
    const res = await contribute({
      food,
      // The server only distinguishes the two AI parses; everything a human
      // typed lands as user_manual either way.
      source: isFix ? "user_manual" : source,
      aiConfidence: isFix ? undefined : aiConfidence,
      userEdited,
    });
    if (res.ok) {
      const merged = res.food ?? food;
      onConfirm(merged);
      return;
    }
    setSave({
      phase: "failed",
      message: isFix
        ? "Saved on your device. We couldn't send your correction in this time."
        : "Logged to your diary. We couldn't share your edit with the community this time.",
    });
    advanceTimer.current = window.setTimeout(() => onConfirm(food), 900);
  };

  const canSave =
    food.name.trim().length >= 2 &&
    Number.isFinite(food.perServing.calories) &&
    save.phase !== "saving";

  return (
    <div className="estimate-screen mode-body">
      <button className="link-btn back-link" onClick={onCancel}>
        <ChevronLeft size={16} /> Back
      </button>

      <input
        className="estimate-title-input"
        aria-label="Product name"
        value={food.name}
        onChange={(e) => update("name", e.target.value)}
        placeholder="Product name"
      />
      <input
        className="estimate-brand-input"
        aria-label="Brand"
        value={food.brand ?? ""}
        onChange={(e) => update("brand", e.target.value || undefined)}
        placeholder="Brand (optional)"
      />

      <div className="notice notice-ai" role="note">
        <div className="notice-ai-headline">
          <AlertTriangle size={16} />{" "}
          {isFix ? "Put in what the package says." : "Heads up: AI made this guess."}
        </div>
        <div className="notice-ai-body">
          {isFix
            ? "Copy the numbers off the nutrition label for one serving. We'll log your version from now on, and send it in so the next person who scans this gets it right."
            : "Double-check the numbers before you save, especially the serving size (that is where vision models trip up most often). Anything you fix here teaches Conjure, so the next person who scans this gets it right."}
        </div>
        {warningNote && <div className="notice-ai-note muted small">{warningNote}</div>}
      </div>

      <div className={`calories-card${lowConfidence ? " low-confidence" : ""}`}>
        <input
          className="estimate-calories-input"
          aria-label="Calories per serving"
          inputMode="decimal"
          type="text"
          value={food.perServing.calories === 0 ? "" : String(food.perServing.calories)}
          placeholder="Tap to enter"
          onChange={(e) =>
            updateMacro("calories", Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)
          }
        />
        <div className="calories-card-label">calories per serving</div>
      </div>

      <div className="macros-edit-row">
        <MacroField
          label="Protein (g)"
          tone="protein"
          value={food.perServing.protein}
          onChange={(v) => updateMacro("protein", v)}
        />
        <MacroField
          label="Carbs (g)"
          tone="carbs"
          value={food.perServing.carbs}
          onChange={(v) => updateMacro("carbs", v)}
        />
        <MacroField
          label="Fat (g)"
          tone="fat"
          value={food.perServing.fat}
          onChange={(v) => updateMacro("fat", v)}
        />
      </div>

      {showAlcoholTop && (
        <MacroField
          label="Alcohol (g)"
          tone="plain"
          value={food.micros?.alcoholG ?? 0}
          onChange={(v) => updateMicro("alcoholG", v || undefined)}
          full
        />
      )}

      <div className="field-row">
        <label className="field">
          <span>Serving size</span>
          <input
            className="text-input"
            value={food.servingSize}
            onChange={(e) => update("servingSize", e.target.value)}
            placeholder="e.g. 1 can (355 ml)"
          />
        </label>
        <label className="field">
          <span>Grams</span>
          <input
            className="text-input"
            inputMode="decimal"
            type="text"
            value={food.servingGrams ?? ""}
            onChange={(e) =>
              update(
                "servingGrams",
                Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined,
              )
            }
          />
        </label>
      </div>
      <div className="muted small">All macros above are per one serving.</div>

      <button
        className="disclosure"
        type="button"
        aria-expanded={moreOpen}
        aria-controls="more-nutrients"
        onClick={() => setMoreOpen((v) => !v)}
      >
        <span>More nutrients</span>
        <ChevronRight
          size={16}
          className={`disclosure-chevron${moreOpen ? " open" : ""}`}
        />
      </button>

      {moreOpen && (
        <div id="more-nutrients" className="more-nutrients">
          <MicroField label="Fiber (g)" v={food.micros?.fiber} onChange={(v) => updateMicro("fiber", v)} />
          <MicroField label="Total sugar (g)" v={food.micros?.sugar} onChange={(v) => updateMicro("sugar", v)} />
          <MicroField label="Added sugar (g)" v={food.micros?.addedSugar} onChange={(v) => updateMicro("addedSugar", v)} />
          <MicroField label="Saturated fat (g)" v={food.micros?.saturatedFat} onChange={(v) => updateMicro("saturatedFat", v)} />
          <MicroField label="Trans fat (g)" v={food.micros?.transFat} onChange={(v) => updateMicro("transFat", v)} />
          <MicroField label="Cholesterol (mg)" v={food.micros?.cholesterolMg} onChange={(v) => updateMicro("cholesterolMg", v)} />
          <MicroField label="Sodium (mg)" v={food.micros?.sodium} onChange={(v) => updateMicro("sodium", v)} />
          <MicroField label="Potassium (mg)" v={food.micros?.potassiumMg} onChange={(v) => updateMicro("potassiumMg", v)} />
          <MicroField label="Calcium (mg)" v={food.micros?.calciumMg} onChange={(v) => updateMicro("calciumMg", v)} />
          <MicroField label="Iron (mg)" v={food.micros?.ironMg} onChange={(v) => updateMicro("ironMg", v)} />
          <MicroField label="Vitamin A (IU)" v={food.micros?.vitaminAIu} onChange={(v) => updateMicro("vitaminAIu", v)} />
          <MicroField label="Vitamin C (mg)" v={food.micros?.vitaminCMg} onChange={(v) => updateMicro("vitaminCMg", v)} />
          <MicroField label="Vitamin D (IU)" v={food.micros?.vitaminDIu} onChange={(v) => updateMicro("vitaminDIu", v)} />
          {!showAlcoholTop && (
            <MicroField label="Alcohol (g)" v={food.micros?.alcoholG} onChange={(v) => updateMicro("alcoholG", v)} />
          )}
          <MicroField label="Caffeine (mg)" v={food.micros?.caffeineMg} onChange={(v) => updateMicro("caffeineMg", v)} />
          <div className="more-nutrients-foot muted small">
            Leave anything you are not sure about blank.
          </div>
        </div>
      )}

      <div className="estimate-source muted small">
        {isFix
          ? "Your correction. It replaces this item on your device straight away; sharing it with everyone else takes a review first."
          : isFront
            ? `Estimated from a front-of-package photo (confidence ${aiConfidence.toFixed(1)}).`
            : `Read from a nutrition-label photo (confidence ${aiConfidence.toFixed(1)}).`}
      </div>

      {save.phase === "failed" && (
        <div className="notice notice-soft" role="status">
          <CheckIcon size={14} /> {save.message}
        </div>
      )}

      <div className="estimate-actions">
        <button className="btn primary block" disabled={!canSave} onClick={onSave}>
          {save.phase === "saving" ? "Saving…" : isFix ? "Save my correction" : "Looks good, log it"}
        </button>
        {save.phase !== "saving" && (
          <button className="link-btn estimate-discard" onClick={onCancel}>
            {isFix ? "Never mind, keep the original" : "Discard this AI estimate"}
          </button>
        )}
      </div>
    </div>
  );
}

function MacroField(props: {
  label: string;
  tone: "protein" | "carbs" | "fat" | "plain";
  value: number;
  onChange: (n: number) => void;
  full?: boolean;
}) {
  return (
    <label className={`macro-edit ${props.tone}${props.full ? " full" : ""}`}>
      <span className="macro-edit-label">{props.label}</span>
      <input
        className="macro-edit-input"
        aria-label={props.label}
        inputMode="decimal"
        type="text"
        value={props.value === 0 ? "" : String(props.value)}
        placeholder="0"
        onChange={(e) =>
          props.onChange(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)
        }
      />
    </label>
  );
}

function MicroField({
  label,
  v,
  onChange,
}: {
  label: string;
  v: number | undefined;
  onChange: (n: number | undefined) => void;
}) {
  return (
    <label className={`more-nutrient-field${v != null ? " detected" : ""}`}>
      <span className="more-nutrient-field-label">{label}</span>
      <input
        inputMode="decimal"
        type="text"
        value={v ?? ""}
        placeholder=""
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.]/g, "");
          onChange(raw ? Number(raw) : undefined);
        }}
      />
    </label>
  );
}
