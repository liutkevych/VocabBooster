import { useCallback, useEffect, useState } from "react";
import { fetchAuthStatus, UNAUTHORIZED_EVENT } from "./api";
import { LoginScreen } from "./LoginScreen";
import { ProgressScreen } from "./ProgressScreen";
import { ReviewScreen } from "./ReviewScreen";
import { SettingsScreen } from "./SettingsScreen";

const TABS = [
  { route: "review", label: "Review" },
  { route: "progress", label: "Progress" },
  { route: "settings", label: "Settings" },
] as const;

type Route = (typeof TABS)[number]["route"];

function routeFromHash(): Route {
  const r = window.location.hash.replace(/^#\/?/, "");
  return TABS.some((t) => t.route === r) ? (r as Route) : "review";
}

/** Hash routes (#/progress) so it works from any static host and survives reloads. */
function useRoute(): Route {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

type AuthState = "checking" | "signed-in" | "signed-out" | "offline";

export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<AuthState>("checking");
  const [authRequired, setAuthRequired] = useState(true);

  const check = useCallback(() => {
    setAuth("checking");
    fetchAuthStatus()
      .then((s) => {
        setAuthRequired(s.required);
        setAuth(s.authenticated ? "signed-in" : "signed-out");
      })
      .catch(() => setAuth("offline"));
  }, []);

  useEffect(check, [check]);

  // Any API call that comes back 401 (e.g. password changed on the server) shows the login screen.
  useEffect(() => {
    const onUnauthorized = () => setAuth("signed-out");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (auth === "checking") {
    return (
      <div className="app">
        <p className="screen muted center">Loading…</p>
      </div>
    );
  }
  if (auth === "offline") {
    return (
      <div className="app">
        <div className="screen center message">
          <p>Can't reach the server.</p>
          <p className="muted small">Check your connection and try again.</p>
          <button type="button" className="primary" onClick={check}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (auth === "signed-out") return <LoginScreen onSignedIn={() => setAuth("signed-in")} />;

  return (
    <div className="app">
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a key={t.route} href={`#/${t.route}`} className="tab" aria-current={route === t.route ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      {route === "review" && <ReviewScreen />}
      {route === "progress" && <ProgressScreen />}
      {route === "settings" && (
        <SettingsScreen onSignedOut={authRequired ? () => setAuth("signed-out") : undefined} />
      )}
    </div>
  );
}
