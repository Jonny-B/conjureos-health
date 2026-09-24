import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * A press-and-HOLD button: the label bar fills over `holdMs` while held, and
 * `onComplete` fires only if the press is held to the end — releasing early
 * cancels. Used for irreversible/terminal actions (ending a workout, committing
 * a finish) so a stray tap can't trigger them, and so repeated taps during a
 * slow save are impossible. Pass `busy` while the resulting async work runs to
 * disable it and show `busyLabel` (this is the loader for that work).
 */
export function HoldButton({
  label,
  holdingLabel = "Keep holding…",
  busyLabel = "Saving…",
  busy = false,
  holdMs = 800,
  onComplete,
  className = "btn primary block",
  danger = false,
  "aria-label": ariaLabel,
}: {
  label: string;
  holdingLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  holdMs?: number;
  onComplete: () => void;
  className?: string;
  danger?: boolean;
  "aria-label"?: string;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);

  const start = () => {
    if (busy || timer.current != null) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onComplete();
    }, holdMs);
  };
  const cancel = () => {
    clear();
    setHolding(false);
  };

  return (
    <button
      type="button"
      className={`hold-btn ${className}${holding ? " holding" : ""}${danger ? " danger" : ""}`}
      disabled={busy}
      aria-label={ariaLabel ?? label}
      style={{ "--hold-ms": `${holdMs}ms` } as CSSProperties}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") cancel();
      }}
    >
      <span className="hold-fill" aria-hidden />
      <span className="hold-label">{busy ? busyLabel : holding ? holdingLabel : label}</span>
    </button>
  );
}
