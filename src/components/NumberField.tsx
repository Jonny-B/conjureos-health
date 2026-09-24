import { useEffect, useState } from "react";

interface Props {
  /** The committed numeric value, or undefined when the field is empty. */
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min?: number;
  max?: number;
  /** Decimal places kept on blur (default 0 = whole numbers). Weight fields
   *  pass 1 so a typed 182.4 isn't silently rounded to 182 when leaving. */
  decimals?: number;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
}

/**
 * A numeric input that lets you actually type. The old profile/goals form
 * clamped every keystroke, so `Number("")===0` snapped a cleared field to the
 * min and a partial "7" (toward "70") jumped to 25 mid-entry. This holds a
 * RAW STRING while editing, allows empty, emits the parsed value live
 * (unclamped, so multi-digit entry isn't fought), and only clamps + rounds on
 * blur. Same pattern the plan wizard already uses for height/weight.
 */
export function NumberField({ value, onChange, min, max, decimals = 0, className = "text-input", placeholder, "aria-label": ariaLabel }: Props) {
  const [raw, setRaw] = useState<string>(value != null ? String(value) : "");
  // Whether the field is currently being edited. Prop→field resync is suppressed
  // while focused (see below).
  const [focused, setFocused] = useState(false);

  // Resync from the outside only when the committed value changes to something
  // the field isn't already showing (e.g. "Use recommended" sets goals). CRUCIAL:
  // never while the field is focused. In a UNIT-CONVERTED field (imperial weight /
  // goal weight) every keystroke emits a value the parent stores as kg (rounded to
  // 0.1) and hands back as a *different* lb number — e.g. typing "1" round-trips to
  // "1.1". Resyncing to that mid-type overwrote the user's digits with the
  // converted value (the "decimals get added while I type" bug) and jumped the
  // caret. While focused, the raw typed string is authoritative; blur clamps/rounds.
  useEffect(() => {
    if (focused) return;
    const typed = raw.trim() === "" ? undefined : Number(raw);
    if (value !== typed) setRaw(value != null ? String(value) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const emit = (s: string) => {
    if (s.trim() === "") {
      onChange(undefined);
      return;
    }
    const n = Number(s);
    if (Number.isFinite(n)) onChange(n);
  };

  const commit = () => {
    if (raw.trim() === "") {
      onChange(undefined);
      return;
    }
    let n = Number(raw);
    if (!Number.isFinite(n)) {
      setRaw("");
      onChange(undefined);
      return;
    }
    const p = 10 ** decimals;
    n = Math.round(n * p) / p;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    setRaw(String(n));
    onChange(n);
  };

  return (
    <input
      className={className}
      type="text"
      inputMode={decimals > 0 ? "decimal" : "numeric"}
      value={raw}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const v = e.target.value;
        // Allow only a numeric shape (digits + one optional dot); empty allowed.
        if (v === "" || /^\d*\.?\d*$/.test(v)) {
          setRaw(v);
          emit(v);
        }
      }}
      onBlur={() => {
        commit();
        setFocused(false);
      }}
    />
  );
}
