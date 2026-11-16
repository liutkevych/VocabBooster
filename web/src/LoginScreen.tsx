import { useState, type FormEvent } from "react";
import { login } from "./api";

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <form className="screen login" onSubmit={submit}>
        <h1 className="screen-title">Vocab Booster</h1>
        {/* Hidden username so password managers save and fill the password reliably. */}
        <input type="text" name="username" autoComplete="username" value="vocab-booster" readOnly hidden />
        <div className="field">
          <label className="field-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
        </div>
        {error && (
          <p id="login-error" className="feedback error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted small">You'll stay signed in on this device for a year.</p>
      </form>
    </div>
  );
}
