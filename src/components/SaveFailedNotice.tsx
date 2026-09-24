import { useEffect, useState } from "react";
import { SAVE_FAILED_EVENT, type SaveFailedDetail } from "../data/saveFailure";

/** Shows the plain message from a failed save until the user dismisses it. */
export function SaveFailedNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onFailed = (e: Event) => {
      const detail = (e as CustomEvent<SaveFailedDetail>).detail;
      if (detail?.message) setMessage(detail.message);
    };
    window.addEventListener(SAVE_FAILED_EVENT, onFailed);
    return () => window.removeEventListener(SAVE_FAILED_EVENT, onFailed);
  }, []);

  if (!message) return null;
  return (
    <div className="notice notice-error save-failed-notice" role="alert">
      <span>{message}</span>
      <button type="button" className="save-failed-dismiss" onClick={() => setMessage(null)}>
        OK
      </button>
    </div>
  );
}
