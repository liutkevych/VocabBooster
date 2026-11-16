import { useEffect, useState } from "react";
import { fetchStats, type Stats } from "./api";

export function ProgressScreen() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    fetchStats()
      .then(setStats)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(load, []);

  if (error) {
    return (
      <div className="screen center message">
        <p>Couldn't load progress.</p>
        <p className="muted small">{error}</p>
        <button type="button" className="primary" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  if (!stats) return <p className="screen muted center">Loading…</p>;

  const { due, words, streak } = stats;
  const learnedPct = words.total ? Math.round((words.learned / words.total) * 100) : 0;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="screen progress">
      <h1 className="screen-title">Progress</h1>

      <div className="tiles">
        <section className="tile" aria-labelledby="due-label">
          <h2 id="due-label" className="tile-label">
            Due today
          </h2>
          <p className="tile-value">{due.today}</p>
          <p className="tile-sub">
            {due.now} ready now · {plural(due.new_remaining, "new card")} to start today
          </p>
        </section>

        <section className="tile" aria-labelledby="learned-label">
          <h2 id="learned-label" className="tile-label">
            Words learned
          </h2>
          <p className="tile-value">
            {words.learned}
            <span className="tile-of"> of {words.total}</span>
          </p>
          <div
            className="bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={learnedPct}
            aria-label="Share of words learned"
          >
            <div className="bar-fill" style={{ width: `${learnedPct}%` }} />
          </div>
          <p className="tile-sub">{words.in_progress} in progress</p>
        </section>

        <section className="tile" aria-labelledby="streak-label">
          <h2 id="streak-label" className="tile-label">
            Study streak
          </h2>
          <p className="tile-value">{plural(streak.days, "day")}</p>
          <p className="tile-sub">
            {streak.studied_today
              ? `Studied today · ${plural(stats.reviews_today, "review")}`
              : streak.days > 0
                ? "Review a card today to keep it going"
                : "Review a card to start a streak"}
          </p>
        </section>
      </div>

      <p className="muted small footnote">
        A word counts as learned once you've passed both directions (English → Ukrainian and back).
      </p>

      {due.now + due.new_remaining > 0 && (
        <a className="primary link-button" href="#/review">
          Start reviewing
        </a>
      )}
    </div>
  );
}
