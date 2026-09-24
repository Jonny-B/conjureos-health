/**
 * Photograph a package: the nutrition panel, the front, or both.
 *
 * This replaced an either/or chooser. The two photos answer different
 * questions — the panel has the real numbers and usually no product name, the
 * front names the thing and is useless for macros — so making people pick one
 * meant every route lost something. Both slots are optional and independent:
 * take one and go, or take both and get a correctly-named item with measured
 * numbers.
 *
 * With only a front photo this falls through to the estimator, which guesses
 * from appearance; with a panel involved the numbers are read, not guessed.
 */

import { useEffect, useRef, useState } from "react";
import { aiErrorMessage, type ChatImage } from "../bridge/ai";
import type { FoodItem } from "../types";
import { parseNutritionLabel } from "../features/foods/labelParse";
import { estimateFromFront, type FrontEstimate } from "../features/foods/frontParse";
import { CameraCapture } from "./CameraCapture";
import { ChevronLeft, NutritionPanelIcon, PackageIcon } from "./icons";

type Slot = "label" | "front";

export interface PackageResult {
  food: FoodItem;
  confidence: number;
  /** Which photos produced this — drives the review screen's framing. */
  source: "ai_label" | "ai_front";
  warningNote?: string;
}

export function PackageCapture({
  barcode,
  onParsed,
  onCancel,
}: {
  barcode?: string;
  onParsed: (result: PackageResult) => void;
  onCancel: () => void;
}) {
  const [shots, setShots] = useState<Partial<Record<Slot, { image: ChatImage; url: string }>>>({});
  const [taking, setTaking] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preview URLs are object URLs; leaking them holds the whole still in memory.
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const captured = (slot: Slot) => (image: ChatImage, url: string) => {
    urls.current.push(url);
    setShots((prev) => {
      const old = prev[slot];
      if (old) URL.revokeObjectURL(old.url);
      return { ...prev, [slot]: { image, url } };
    });
    setTaking(null);
    setError(null);
  };

  const clear = (slot: Slot) =>
    setShots((prev) => {
      const old = prev[slot];
      if (old) URL.revokeObjectURL(old.url);
      const next = { ...prev };
      delete next[slot];
      return next;
    });

  const read = async () => {
    const label = shots.label?.image;
    const front = shots.front?.image;
    if (!label && !front) return;
    setBusy(true);
    setError(null);
    try {
      if (label) {
        // The panel leads whenever we have one; a front photo only names it.
        const res = await parseNutritionLabel(label, barcode, front);
        if (!res) {
          setError(
            "That didn't read as a nutrition panel. Try a straighter, closer shot of the Nutrition Facts — or drop the panel and use just the front.",
          );
          return;
        }
        onParsed({ food: res.food, confidence: res.confidence, source: "ai_label" });
        return;
      }
      const est: FrontEstimate | null = await estimateFromFront(front!, barcode);
      if (!est) {
        setError("Couldn't make out a food in that photo. Try again, or add the nutrition panel.");
        return;
      }
      onParsed({
        food: est.food,
        confidence: est.confidence,
        source: "ai_front",
        ...(est.warningNote ? { warningNote: est.warningNote } : {}),
      });
    } catch (err) {
      setError(aiErrorMessage(err, "The estimator didn’t respond. Try again."));
    } finally {
      setBusy(false);
    }
  };

  if (taking) {
    return (
      <div className="mode-body">
        <button className="link-btn back-link" onClick={() => setTaking(null)}>
          <ChevronLeft size={16} /> Back
        </button>
        <CameraCapture
          guide={
            taking === "label"
              ? "Fill the frame with the Nutrition Facts panel. Straight on, no glare."
              : "Show the front of the package, with the product name readable."
          }
          onCapture={captured(taking)}
        />
      </div>
    );
  }

  const count = (shots.label ? 1 : 0) + (shots.front ? 1 : 0);

  return (
    <div className="mode-body package-capture">
      <button className="link-btn back-link" onClick={onCancel}>
        <ChevronLeft size={16} /> Back
      </button>

      <div className="snap-miss-copy">
        <div>Photograph the package</div>
        <div className="muted small">
          Either one works on its own. Both together is best — the panel has the real numbers, the
          front has the product name.
        </div>
      </div>

      <div className="shot-slots">
        <ShotSlot
          label="Nutrition label"
          hint="The numbers"
          icon={<NutritionPanelIcon size={24} />}
          shot={shots.label}
          onTake={() => setTaking("label")}
          onClear={() => clear("label")}
        />
        <ShotSlot
          label="Front of package"
          hint="The name"
          icon={<PackageIcon size={24} />}
          shot={shots.front}
          onTake={() => setTaking("front")}
          onClear={() => clear("front")}
        />
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <button className="btn primary block" disabled={busy || count === 0} onClick={read}>
        {busy
          ? "Reading…"
          : count === 0
            ? "Add a photo to continue"
            : count === 2
              ? "Read both"
              : shots.label
                ? "Read the label"
                : "Estimate from the front"}
      </button>

      {count === 1 && !busy && (
        <div className="muted small package-nudge">
          {shots.label
            ? "Adding the front helps us name it correctly."
            : "Adding the nutrition panel gives measured numbers instead of an estimate."}
        </div>
      )}
    </div>
  );
}

function ShotSlot({
  label,
  hint,
  icon,
  shot,
  onTake,
  onClear,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  shot?: { url: string };
  onTake: () => void;
  onClear: () => void;
}) {
  return (
    <div className={`shot-slot${shot ? " filled" : ""}`}>
      <button className="shot-slot-main" onClick={onTake} aria-label={shot ? `Retake ${label}` : `Add ${label}`}>
        {shot ? (
          <img className="shot-thumb" src={shot.url} alt="" />
        ) : (
          <span className="shot-slot-icon" aria-hidden>
            {icon}
          </span>
        )}
        <span className="shot-slot-text">
          <span className="shot-slot-label">{label}</span>
          <span className="shot-slot-hint muted small">{shot ? "Tap to retake" : hint}</span>
        </span>
      </button>
      {shot && (
        <button className="link-btn shot-clear" onClick={onClear}>
          Remove
        </button>
      )}
    </div>
  );
}
