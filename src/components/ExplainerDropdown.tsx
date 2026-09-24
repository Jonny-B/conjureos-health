import { useState } from "react";
import type { ExerciseExplainer } from "../types";
import { normalizeExerciseKey } from "../features/explainers/normalizeKey";
import { resolveExplainer, saveUserExplainer } from "../features/explainers/resolve";
import { persist } from "../data/saveFailure";

interface Props {
  name: string;
}

const SOURCE_LABEL: Record<ExerciseExplainer["source"], string> = {
  user: "Your note",
  coach: "Coach",
  ai: "AI",
};

/**
 * Collapsible "how to do it / what it works" panel for an exercise. Resolves
 * the explainer lazily on first expand (VFS user → trainer → AI-cached), shows
 * a source badge, and lets the user write/override their own note (saved to
 * VFS, wins over AI on next open).
 */
export function ExplainerDropdown({ name }: Props) {
  const key = normalizeExerciseKey(name);
  const [open, setOpen] = useState(false);
  // undefined = not loaded, null = none available.
  const [explainer, setExplainer] = useState<ExerciseExplainer | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [howTo, setHowTo] = useState("");
  const [muscles, setMuscles] = useState("");
  const [useful, setUseful] = useState("");

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && explainer === undefined && !loading) {
      setLoading(true);
      const r = await resolveExplainer(key, name).catch(() => null);
      setExplainer(r);
      setLoading(false);
    }
  };

  const startEdit = () => {
    setHowTo(explainer?.howTo ?? "");
    setMuscles((explainer?.worksMuscles ?? []).join(", "));
    setUseful(explainer?.usefulData ?? "");
    setEditing(true);
  };

  const saveEdit = async () => {
    const e: ExerciseExplainer = {
      exerciseKey: key,
      howTo: howTo.trim(),
      worksMuscles: muscles.split(",").map((m) => m.trim()).filter(Boolean),
      usefulData: useful.trim() || undefined,
      source: "user",
    };
    if (!(await persist("your explanation", saveUserExplainer(e)))) return;
    setExplainer(e);
    setEditing(false);
  };

  return (
    <div className="explainer">
      <button className="explainer-toggle link-btn" onClick={toggle}>
        {open ? "Hide how-to" : "How to do it"}
      </button>

      {open && (
        <div className="explainer-body">
          {loading ? (
            <div className="muted small">Loading…</div>
          ) : editing ? (
            <div className="explainer-edit">
              <textarea className="text-area" rows={3} placeholder="How to do it" value={howTo} onChange={(e) => setHowTo(e.target.value)} />
              <input className="text-input" placeholder="Muscles worked (comma-separated)" value={muscles} onChange={(e) => setMuscles(e.target.value)} />
              <input className="text-input" placeholder="Tips / typical range" value={useful} onChange={(e) => setUseful(e.target.value)} />
              <div className="row gap">
                <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                <button className="btn primary" disabled={!howTo.trim()} onClick={saveEdit}>Save note</button>
              </div>
            </div>
          ) : explainer ? (
            <>
              <div className="explainer-head">
                <span className={`explainer-source src-${explainer.source}`}>{SOURCE_LABEL[explainer.source]}</span>
                <button className="link-btn explainer-edit-btn" onClick={startEdit}>Edit</button>
              </div>
              <p className="explainer-howto">{explainer.howTo}</p>
              {explainer.worksMuscles && explainer.worksMuscles.length > 0 && (
                <div className="explainer-muscles">
                  {explainer.worksMuscles.map((m) => (
                    <span key={m} className="muscle-chip">{m}</span>
                  ))}
                </div>
              )}
              {explainer.usefulData && <p className="explainer-useful muted small">{explainer.usefulData}</p>}
            </>
          ) : (
            <div className="explainer-empty">
              <p className="muted small">No explainer yet.</p>
              <button className="link-btn" onClick={startEdit}>Write one</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
