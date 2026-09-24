/**
 * Inline-SVG icon set. Replaces the grab-bag of emoji + Unicode glyphs the app
 * used for tabs/buttons (☰ ＋ 📈 🏋 ⚙ ◴), which render inconsistently across
 * platforms and clashed with the Modern Whimsy look. These are stroke icons
 * that inherit `currentColor`, so they pick up the active/muted tab colors and
 * any button text color for free.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

/** App mark — three concentric activity arcs (calorie/macro rings motif). */
export function Logo({ size = 22, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden {...rest}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
      <path
        d="M12 3a9 9 0 0 1 8.5 6.1"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
      <path d="M12 7.5a4.5 4.5 0 0 1 3.9 2.25" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** App mark — a whole apple, matching Conjure Health's `fa:apple-whole` store
 *  icon so the in-app header brand reads the same as the App Store tile. */
export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
);

export const AppleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06z" />
    <path d="M10 2c1 .5 2 2 2 5" />
  </Svg>
);

/** Tab icon: the food diary (an open notebook). */
export const DiaryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M4 17.5A1.5 1.5 0 0 1 5.5 16H20" />
    <path d="M8 8h7M8 11h5" />
  </Svg>
);

/** Primary action: add / log something new. */
export const AddIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

/** Tab icon: trends and charts over time. */
export const TrendsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 17l5-5 3.5 3.5L21 7" />
    <path d="M21 11V7h-4" />
  </Svg>
);

/** Tab icon: workouts (a dumbbell). */
export const WorkoutsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 6.5v11M17.5 6.5v11M4 9v6M20 9v6M6.5 12h11" />
  </Svg>
);

/** The settings cog. */
export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
  </Svg>
);

/** Search affordance — a magnifier. */
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
);

/** Start a workout or a timed step. */
export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 7 5.5z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Back / previous affordance. */
export const ChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

/** Forward / next / drill-in affordance. */
export const ChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
);

/** Dismiss a sheet, modal, or full-screen flow. */
export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

/** Edit the adjacent item in place. */
export const EditIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
);

/** Delete the adjacent item. */
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
  </Svg>
);

/** Capture entry point: snap a Nutrition Facts panel. */
export const NutritionPanelIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M7 8h10M7 12h10M7 16h6" />
  </Svg>
);

/** Capture entry point: snap the front of a package. */
export const PackageIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7l9-4 9 4-9 4-9-4z" />
    <path d="M3 7v10l9 4 9-4V7" />
    <path d="M12 11v10" />
  </Svg>
);

/** Capture entry point: scan a product barcode. */
export const BarcodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4H7M17 4h1.5A1.5 1.5 0 0 1 20 5.5V7M20 17v1.5a1.5 1.5 0 0 1-1.5 1.5H17M7 20H5.5A1.5 1.5 0 0 1 4 18.5V17" />
    <path d="M7 8v8M10 8v8M13 8v8M16.5 8v8" />
  </Svg>
);

/** Toggle the camera torch while scanning. */
export const FlashlightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3h6l-.3 3.5a2 2 0 0 1-.5 1.2L13 9v9a1 1 0 0 1-1 1 1 1 0 0 1-1-1V9L9.8 7.7a2 2 0 0 1-.5-1.2L9 3z" />
    <path d="M9.2 6h5.6" />
  </Svg>
);

/** Fall back to typing a barcode/food by hand. */
export const KeyboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
  </Svg>
);

/** Open the camera / take a photo. */
export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8a2 2 0 0 1 2-2h1.5l1-1.5A1 1 0 0 1 8.3 4h7.4a1 1 0 0 1 .8.5L17.5 6H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);

/** The AI coach — a speech bubble with a spark. */
export const CoachIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.1 0-2.15-.2-3.1-.58L4 21l1.62-4.86A8.5 8.5 0 1 1 21 11.5z" />
    <path d="M8.5 10.5h7M8.5 13.5h4.5" />
  </Svg>
);

/** AI mark — a four-point sparkle/diamond, the ConjureOS "this is AI" motif. */
export const DiamondIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3c0 5 4 9 9 9-5 0-9 4-9 9 0-5-4-9-9-9 5 0 9-4 9-9z" />
  </Svg>
);

/** Confirmation: saved, completed, or selected. */
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
);

/** Warning or estimate caveat. */
export const AlertTriangle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </Svg>
);
