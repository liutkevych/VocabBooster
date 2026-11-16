import { useCallback, useEffect, useRef, useState } from "react";
import { fetchQueue, postReviewWithRetry, type Queue, type QueueCard, type Rating, type ReviewSubmission } from "./api";
import { formatInterval, formatUntil } from "./format";
import { speak, speechSupported, stopSpeaking } from "./speech";

const RATINGS: Array<{ rating: Rating; label: string; key: string }> = [
  { rating: 1, label: "Again", key: "again" },
  { rating: 2, label: "Hard", key: "hard" },
  { rating: 3, label: "Good", key: "good" },
  { rating: 4, label: "Easy", key: "easy" },
];

/** Re-check for cards when the next one is due within this window while the app is open. */
const AUTO_REFRESH_WINDOW_MS = 2 * 60 * 60 * 1000;

const AUDIO_PREF_KEY = "vocab.audio";

function readAudioPref(): boolean {
  try {
    return localStorage.getItem(AUDIO_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeAudioPref(on: boolean) {
  try {
    localStorage.setItem(AUDIO_PREF_KEY, on ? "on" : "off");
  } catch {
    /* private mode etc.: preference just isn't remembered */
  }
}

type Status = "loading" | "ready" | "error";

export function ReviewScreen({ deck = "main" }: { deck?: "main" | "other" }) {
  const [cards, setCards] = useState<QueueCard[]>([]);
  const [counts, setCounts] = useState<Queue["counts"] | null>(null);
  const [nextDueAt, setNextDueAt] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [failed, setFailed] = useState<ReviewSubmission[]>([]);
  const [audioOn, setAudioOn] = useState(readAudioPref);

  const pending = useRef(new Set<Promise<void>>());
  const shownAt = useRef(Date.now());
  const audioOnRef = useRef(audioOn);
  audioOnRef.current = audioOn;

  const current = cards[0];

  const load = useCallback(async () => {
    setStatus("loading");
    // Let in-flight reviews land first so the server's queue reflects them.
    await Promise.allSettled([...pending.current]);
    try {
      const q = await fetchQueue(deck);
      setCards(q.cards);
      setCounts(q.counts);
      setNextDueAt(q.next_due_at);
      setRevealed(false);
      setError(null);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [deck]);

  useEffect(() => {
    void load();
  }, [load]);

  // Time how long each card takes to answer.
  useEffect(() => {
    shownAt.current = Date.now();
  }, [current?.id]);

  // Speak the English side when it appears: the front for EN→UK, the answer for UK→EN.
  useEffect(() => {
    if (!current || !audioOnRef.current) return;
    const side = revealed ? current.back : current.front;
    if (side.lang === "en") speak(side.text);
  }, [current, revealed]);

  // Nothing left: check back when the next learning card is due.
  useEffect(() => {
    if (status !== "ready" || current || !nextDueAt) return;
    const ms = Date.parse(nextDueAt) - Date.now();
    if (ms > AUTO_REFRESH_WINDOW_MS) return;
    const timer = setTimeout(() => void load(), Math.max(1000, ms + 500));
    return () => clearTimeout(timer);
  }, [status, current, nextDueAt, load]);

  // Coming back to the app (e.g. next tram ride) with nothing on screen: refresh.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !current && status !== "loading") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [current, status, load]);

  const submit = useCallback((sub: ReviewSubmission) => {
    const p: Promise<void> = postReviewWithRetry(sub)
      .catch(() => setFailed((f) => [...f, sub]))
      .finally(() => pending.current.delete(p));
    pending.current.add(p);
  }, []);

  const reveal = useCallback(() => {
    if (current && !revealed) setRevealed(true);
  }, [current, revealed]);

  const rate = useCallback(
    (rating: Rating) => {
      if (!current || !revealed) return;
      stopSpeaking();
      submit({
        card_id: current.id,
        rating,
        client_review_id: crypto.randomUUID(),
        duration_ms: Date.now() - shownAt.current,
      });

      setCounts((c) => {
        if (!c) return c;
        if (current.state === 0) return { ...c, new: Math.max(0, c.new - 1) };
        if (current.state === 2) return { ...c, review: Math.max(0, c.review - 1) };
        return { ...c, learning: Math.max(0, c.learning - 1) };
      });

      const rest = cards.slice(1);
      setCards(rest);
      setRevealed(false);
      // Refetch when the local list runs out, or when a learning card has come due meanwhile.
      const learningDue = nextDueAt !== null && Date.parse(nextDueAt) <= Date.now();
      if (rest.length === 0 || learningDue) void load();
    },
    [current, revealed, cards, nextDueAt, submit, load],
  );

  const retryFailed = () => {
    const toRetry = failed;
    setFailed([]);
    toRetry.forEach(submit); // same client_review_id, so a retry never double-counts
  };

  // Desktop shortcuts: Space/Enter reveals, 1–4 rates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === " " || e.key === "Enter") && !revealed) {
        e.preventDefault();
        reveal();
      } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        rate(Number(e.key) as Rating);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, reveal, rate]);

  const toggleAudio = () => {
    const next = !audioOn;
    setAudioOn(next);
    writeAudioPref(next);
    if (!next) stopSpeaking();
  };

  return (
    <div className="screen review">
      <header className="topbar">
        {counts ? (
          <div className="counts" aria-label="Cards left">
            <span className="count new">
              <b>{counts.new}</b> new
            </span>
            <span className="count learning">
              <b>{counts.learning}</b> learning
            </span>
            <span className="count review">
              <b>{counts.review}</b> due
            </span>
          </div>
        ) : (
          <span />
        )}
        {speechSupported() && (
          <button type="button" className="icon-btn" onClick={toggleAudio} aria-pressed={audioOn}>
            {audioOn ? "Sound on" : "Sound off"}
          </button>
        )}
      </header>

      {failed.length > 0 && (
        <div className="banner" role="alert">
          <span>
            {failed.length} {failed.length === 1 ? "review wasn't" : "reviews weren't"} saved.
          </span>
          <button type="button" onClick={retryFailed}>
            Retry
          </button>
        </div>
      )}

      <main className="stage">
        {status === "loading" && !current && <p className="muted center">Loading…</p>}

        {status === "error" && (
          <div className="center message">
            <p>Couldn't load cards.</p>
            <p className="muted small">{error}</p>
            <button type="button" className="primary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {status === "ready" && !current && (
          <div className="center message">
            <p className="done-title">All caught up</p>
            <p className="muted">
              {nextDueAt ? `Next card ${formatUntil(nextDueAt)}.` : "No cards due. Sync more words to keep going."}
            </p>
          </div>
        )}

        {status !== "error" && current && (
          <Card card={current} revealed={revealed} onReveal={reveal} />
        )}
      </main>

      {status !== "error" && current && (
        <footer className="actions">
          {revealed ? (
            <div className="ratings">
              {RATINGS.map(({ rating, label, key }) => (
                <button key={rating} type="button" className={`rate ${key}`} onClick={() => rate(rating)}>
                  <span className="rate-label">{label}</span>
                  <span className="rate-interval">{formatInterval(current.preview[rating])}</span>
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className="primary show" onClick={reveal}>
              Show answer
            </button>
          )}
        </footer>
      )}
    </div>
  );
}

function Card({
  card,
  revealed,
  onReveal,
}: {
  card: QueueCard;
  revealed: boolean;
  onReveal: () => void;
}) {
  const direction = card.direction === "en_uk" ? "English → Ukrainian" : "Ukrainian → English";
  return (
    <div
      className={`card${revealed ? " revealed" : ""}`}
      onClick={onReveal}
      data-testid="card"
      aria-live="polite"
    >
      <p className="direction">
        {direction}
        {card.state === 0 && <span className="badge">new</span>}
      </p>
      <Side side={card.front} className="front" />
      {revealed ? (
        <>
          <hr className="divider" />
          <Side side={card.back} className="back" />
        </>
      ) : (
        <p className="hint muted">Tap to show answer</p>
      )}
    </div>
  );
}

function Side({ side, className }: { side: QueueCard["front"]; className: string }) {
  const canSpeak = side.lang === "en" && speechSupported();
  return (
    <div className={`side ${className}`}>
      <span className="word" lang={side.lang}>
        {side.text}
      </span>
      {canSpeak && (
        <button
          type="button"
          className="replay"
          aria-label={`Play pronunciation of ${side.text}`}
          onClick={(e) => {
            e.stopPropagation(); // don't also reveal the card
            speak(side.text);
          }}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path
              fill="currentColor"
              d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
