/**
 * A lightweight area sparkline (no point markers, stretched to fill width).
 * Shared by the Weight screen and the home Weight card.
 */
export function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2)
    return <div className="sparkline-empty muted small">Log a few days to see your trend.</div>;
  const W = 280;
  const H = 64;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((p, i) => ({
    x: (i / (points.length - 1)) * W,
    y: H - ((p - min) / span) * (H - 10) - 5,
  }));
  const line = xy.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
  // Close the path down to the baseline so we can fill the area under the line.
  const area = `${line} L${W},${H} L0,${H} Z`;
  return (
    // preserveAspectRatio="none" stretches the path to fill the container width;
    // we deliberately use no point markers here since a <circle> would distort.
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--cui-accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--cui-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} className="sparkline-area" />
      <path d={line} className="sparkline-path" />
    </svg>
  );
}
