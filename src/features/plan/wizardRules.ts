/** Small pure rules behind the plan wizard's form state, kept out of the screen
 *  so they can be unit-tested without a DOM. */

import type { ActivityLevel } from "../../types";

/**
 * Whether the wizard may move past the body-stats steps. Age is always required
 * (the under-18 gate and the stored profile both depend on it, in every mode);
 * height and weight only when the plan tracks food.
 */
export function wizardInputsValid(
  tracksFood: boolean,
  v: { age?: number; heightCm?: number; weightKg?: number },
): boolean {
  return v.age != null && (tracksFood ? v.heightCm != null && v.weightKg != null : true);
}

/**
 * The activity level to preselect. The wizard's chips stop at "active" (labelled
 * "Very active"), but older profiles can still store "very_active", which would
 * leave every chip unselected, so show it as the nearest chip.
 */
export function seedActivityLevel(stored: ActivityLevel | undefined): ActivityLevel {
  if (stored === "very_active") return "active";
  return stored ?? "moderate";
}
