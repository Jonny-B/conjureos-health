import { CloseIcon } from "./icons";

/**
 * Dismissible "build your plan" banner shown above the Today tracker while no
 * plan exists. Tapping it opens the plan wizard as a full-page dialog; the X
 * hides it for the session (it returns on reload while there's still no plan).
 * Reuses the `.setup-banner*` styling from the retired profile-setup banner.
 */
export function PlanBanner({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="setup-banner">
      <button className="setup-banner-main" onClick={onOpen}>
        <span className="setup-banner-text">Build your plan: set your calorie and macro targets</span>
        <span className="setup-banner-cta">Start</span>
      </button>
      <button className="icon-btn setup-banner-x" aria-label="Dismiss" onClick={onDismiss}>
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
