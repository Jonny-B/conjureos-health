/**
 * Tiny inline badge marking a diary entry whose calories/macros are an
 * unreviewed AI estimate (logged by name via the assistant or the Describe
 * tab). Honest-by-default: the user should never mistake a guess for a scanned
 * label. Shown next to the food name in the diary and meal-detail lists.
 */
export function AiEstimateBadge() {
  return (
    <span
      className="ai-estimate-badge"
      title="Estimated by AI from the name — may be inaccurate. Adjust the quantity or re-log with exact numbers."
    >
      AI estimate
    </span>
  );
}
