import { useEffect, useMemo, useState, type FormEvent } from "react";
import { fetchSettings, importCsv, logout, saveSettings, syncNow, type Settings } from "./api";
import { summarizeImport } from "./format";

type Feedback = { kind: "ok" | "error"; text: string } | null;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** onSignedOut is omitted when the server has no password (local development). */
export function SettingsScreen({ onSignedOut }: { onSignedOut?: () => void } = {}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newPerDay, setNewPerDay] = useState("");
  const [sheet, setSheet] = useState("");
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<Feedback>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<Feedback>(null);
  const [importing, setImporting] = useState(false);
  const [importFeedback, setImportFeedback] = useState<Feedback>(null);

  const apply = (s: Settings) => {
    setSettings(s);
    setNewPerDay(String(s.new_cards_per_day));
    setSheet(s.sheet_id ?? "");
    setTimezone(s.timezone);
  };

  useEffect(() => {
    fetchSettings()
      .then(apply)
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  const timezones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    // Make sure the saved value and "UTC" are always selectable.
    return [...new Set(["UTC", timezone, ...all].filter(Boolean))].sort();
  }, [timezone]);

  const dirty =
    settings !== null &&
    (newPerDay !== String(settings.new_cards_per_day) || sheet.trim() !== (settings.sheet_id ?? "") || timezone !== settings.timezone);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(newPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      setSaveFeedback({ kind: "error", text: "New cards per day must be a whole number from 0 to 1000." });
      return;
    }
    setSaving(true);
    setSaveFeedback(null);
    try {
      apply(await saveSettings({ new_cards_per_day: n, sheet_id: sheet.trim() || null, timezone }));
      setSaveFeedback({ kind: "ok", text: "Saved." });
    } catch (err) {
      setSaveFeedback({ kind: "error", text: errorText(err) });
    } finally {
      setSaving(false);
    }
  };

  const onSync = async () => {
    setSyncing(true);
    setSyncFeedback(null);
    try {
      const summary = await syncNow();
      setSyncFeedback({ kind: "ok", text: summarizeImport(summary) });
      apply(await fetchSettings()); // picks up last_sync_at
    } catch (err) {
      setSyncFeedback({ kind: "error", text: errorText(err) });
    } finally {
      setSyncing(false);
    }
  };

  const onCsv = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportFeedback(null);
    try {
      const summary = await importCsv(await file.text());
      setImportFeedback({ kind: "ok", text: `${file.name}: ${summarizeImport(summary)}` });
    } catch (err) {
      setImportFeedback({ kind: "error", text: errorText(err) });
    } finally {
      setImporting(false);
    }
  };

  if (loadError) {
    return (
      <div className="screen center message">
        <p>Couldn't load settings.</p>
        <p className="muted small">{loadError}</p>
      </div>
    );
  }
  if (!settings) return <p className="screen muted center">Loading…</p>;

  return (
    <div className="screen settings">
      <h1 className="screen-title">Settings</h1>

      <form className="panel" onSubmit={onSave} noValidate>
        <div className="field">
          <label className="field-label" htmlFor="new-per-day">
            New words per day
          </label>
          <input
            id="new-per-day"
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={newPerDay}
            onChange={(e) => setNewPerDay(e.target.value)}
            aria-describedby="new-per-day-help"
          />
          <p id="new-per-day-help" className="field-help">
            Reviews of words you've already started are never capped.
          </p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="timezone">
            Timezone
          </label>
          <select
            id="timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-describedby="timezone-help"
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p id="timezone-help" className="field-help">
            Sets when your day starts, for the new-word limit and your streak.{" "}
            {timezone !== deviceTimezone() && (
              <button type="button" className="text-button" onClick={() => setTimezone(deviceTimezone())}>
                Use this device's ({deviceTimezone()})
              </button>
            )}
          </p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="sheet">
            Google Sheet
          </label>
          <input
            id="sheet"
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Sheet link or ID"
            value={sheet}
            onChange={(e) => setSheet(e.target.value)}
            aria-describedby="sheet-help"
          />
          <p id="sheet-help" className="field-help">
            Export your saved words from Google Translate to Sheets, share the Sheet with the app's service account,
            then paste its link here.
          </p>
        </div>

        <div className="form-actions">
          <button type="submit" className="primary compact" disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saveFeedback && <FeedbackText feedback={saveFeedback} />}
        </div>
      </form>

      <section className="panel" aria-labelledby="sync-title">
        <h2 id="sync-title" className="panel-title">
          Sync from Google Sheet
        </h2>
        <p className="muted small">
          {settings.last_sync_at ? `Last synced ${formatDateTime(settings.last_sync_at)}.` : "Not synced yet."} The
          server also syncs once a day.
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="primary compact"
            onClick={onSync}
            disabled={syncing || !settings.sheet_id || dirty}
            title={dirty ? "Save your changes first" : undefined}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {syncFeedback && <FeedbackText feedback={syncFeedback} />}
        </div>
        {!settings.sheet_id && <p className="muted small">Add your Google Sheet above first.</p>}
      </section>

      <section className="panel" aria-labelledby="csv-title">
        <h2 id="csv-title" className="panel-title">
          Import a CSV file
        </h2>
        <p className="muted small">
          Same columns as the Google Translate export. Adds and updates words; never removes any.
        </p>
        <div className="form-actions">
          <label className={`secondary compact file-button${importing ? " disabled" : ""}`}>
            {importing ? "Importing…" : "Choose CSV file"}
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={importing}
              onChange={(e) => {
                void onCsv(e.target.files?.[0]);
                e.target.value = ""; // allow picking the same file again
              }}
            />
          </label>
          {importFeedback && <FeedbackText feedback={importFeedback} />}
        </div>
      </section>

      {onSignedOut && (
        <button
          type="button"
          className="secondary compact sign-out"
          onClick={() => {
            void logout().finally(onSignedOut);
          }}
        >
          Sign out on this device
        </button>
      )}
    </div>
  );
}

function FeedbackText({ feedback }: { feedback: NonNullable<Feedback> }) {
  return (
    <p className={`feedback ${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>
      {feedback.text}
    </p>
  );
}
