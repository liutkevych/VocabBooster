import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { ProgressScreen } from "../src/ProgressScreen";
import { SettingsScreen } from "../src/SettingsScreen";
import type { Settings, Stats } from "../src/api";

interface Call {
  url: string;
  method: string;
  body?: string;
  contentType?: string;
}
let calls: Call[];

type Handler = (call: Call) => { status?: number; body: unknown };

function mockFetch(handler: Handler) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call = { url, method: init?.method ?? "GET", body: init?.body as string | undefined, contentType: headers["content-type"] };
      calls.push(call);
      const { status = 200, body } = handler(call);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}

const stats = (over: Partial<Stats> = {}): Stats => ({
  today: "2026-01-05",
  timezone: "Europe/Kyiv",
  due: { now: 4, today: 7, new_remaining: 12 },
  reviews_today: 9,
  words: { total: 40, learned: 10, in_progress: 6 },
  streak: { days: 3, studied_today: true },
  ...over,
});

const baseSettings: Settings = {
  new_cards_per_day: 20,
  sheet_id: "SHEET1",
  last_sync_at: "2026-01-05T04:00:00Z",
  timezone: "UTC",
};

beforeEach(() => {
  calls = [];
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("ProgressScreen", () => {
  it("shows due today, words learned, and the streak", async () => {
    mockFetch(() => ({ body: stats() }));
    render(<ProgressScreen />);

    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.getByText(/4 ready now · 12 new cards to start today/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("6 in progress")).toBeInTheDocument();
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(screen.getByText("Studied today · 9 reviews")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start reviewing" })).toHaveAttribute("href", "#/review");
  });

  it("nudges to keep the streak when today isn't done yet, and hides the button when nothing is due", async () => {
    mockFetch(() => ({
      body: stats({ streak: { days: 1, studied_today: false }, due: { now: 0, today: 0, new_remaining: 0 } }),
    }));
    render(<ProgressScreen />);
    expect(await screen.findByText("1 day")).toBeInTheDocument();
    expect(screen.getByText("Review a card today to keep it going")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Start reviewing" })).not.toBeInTheDocument();
  });
});

describe("SettingsScreen", () => {
  function settingsServer(over: Partial<Settings> = {}) {
    let current = { ...baseSettings, ...over };
    mockFetch(({ url, method, body }) => {
      if (url.endsWith("/settings") && method === "PUT") {
        const update = JSON.parse(body!);
        if (update.timezone === "Bad/Zone") return { status: 400, body: { error: "Invalid request", issues: [{ message: "Unknown IANA timezone" }] } };
        current = { ...current, ...update };
        return { body: current };
      }
      if (url.endsWith("/settings")) return { body: current };
      if (url.endsWith("/sync")) {
        current = { ...current, last_sync_at: "2026-01-05T09:00:00Z" };
        return { body: { total: 12, added: 3, updated: 1, restored: 0, archived: 2, unchanged: 6, skipped: 1 } };
      }
      if (url.endsWith("/import/csv")) {
        return { body: { total: 2, added: 2, updated: 0, restored: 0, archived: 0, unchanged: 0, skipped: 0 } };
      }
      return { status: 404, body: {} };
    });
  }

  it("loads, edits and saves settings", async () => {
    settingsServer();
    const user = userEvent.setup();
    render(<SettingsScreen />);

    const perDay = await screen.findByRole("spinbutton", { name: "New words per day" });
    expect(perDay).toHaveValue(20);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.clear(perDay);
    await user.type(perDay, "10");
    await user.selectOptions(screen.getByRole("combobox", { name: "Timezone" }), "Europe/Berlin");
    await user.clear(screen.getByRole("textbox", { name: "Google Sheet" }));
    await user.type(screen.getByRole("textbox", { name: "Google Sheet" }), "https://docs.google.com/spreadsheets/d/NEW/edit");
    await user.click(save);

    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({
      new_cards_per_day: 10,
      timezone: "Europe/Berlin",
      sheet_id: "https://docs.google.com/spreadsheets/d/NEW/edit",
    });
    expect(save).toBeDisabled();
  });

  it("checks the number locally and shows server validation messages", async () => {
    settingsServer({ timezone: "Bad/Zone" });
    const user = userEvent.setup();
    render(<SettingsScreen />);

    const perDay = await screen.findByRole("spinbutton", { name: "New words per day" });
    await user.clear(perDay);
    await user.type(perDay, "2.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("whole number");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    await user.clear(perDay);
    await user.type(perDay, "5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Unknown IANA timezone")).toBeInTheDocument();
  });

  it("syncs now and shows what changed", async () => {
    settingsServer();
    const user = userEvent.setup();
    render(<SettingsScreen />);

    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Added 3 · updated 1 · archived 2 · 1 skipped")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Last synced/)).toHaveTextContent(/2026/));
  });

  it("can't sync without a sheet", async () => {
    settingsServer({ sheet_id: null, last_sync_at: null });
    render(<SettingsScreen />);
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByText("Not synced yet.", { exact: false })).toBeInTheDocument();
  });

  it("uploads a CSV file as text/csv", async () => {
    settingsServer();
    const user = userEvent.setup();
    const { container } = render(<SettingsScreen />);
    await screen.findByText("Choose CSV file");

    const file = new File(["English,Ukrainian,cat,кіт\n"], "words.csv", { type: "text/csv" });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    expect(await screen.findByText("words.csv: Added 2")).toBeInTheDocument();
    const post = calls.find((c) => c.url.endsWith("/import/csv"))!;
    expect(post.contentType).toBe("text/csv");
    expect(post.body).toBe("English,Ukrainian,cat,кіт\n");
  });
});

const emptyQueue = { cards: [], counts: { new: 0, learning: 0, review: 0 }, new_limit: { per_day: 20, introduced_today: 0 }, next_due_at: null };

describe("App navigation", () => {
  it("switches screens with the tabs", async () => {
    mockFetch(({ url }) => {
      if (url.includes("/auth/me")) return { body: { authenticated: true, required: true } };
      if (url.includes("/stats")) return { body: stats() };
      if (url.includes("/settings")) return { body: baseSettings };
      return { body: { cards: [], counts: { new: 0, learning: 0, review: 0 }, new_limit: { per_day: 20, introduced_today: 0 }, next_due_at: null } };
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("link", { name: "Progress" }));
    expect(await screen.findByRole("heading", { name: "Progress" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("Signing in", () => {
  function authServer(opts: { password: string; signedIn?: boolean }) {
    let signedIn = opts.signedIn ?? false;
    mockFetch(({ url, method, body }) => {
      if (url.endsWith("/auth/me")) return { body: { authenticated: signedIn, required: true } };
      if (url.endsWith("/auth/login")) {
        if (JSON.parse(body!).password !== opts.password) return { status: 401, body: { error: "Wrong password" } };
        signedIn = true;
        return { body: { authenticated: true } };
      }
      if (url.endsWith("/auth/logout") && method === "POST") {
        signedIn = false;
        return { body: { authenticated: false } };
      }
      if (!signedIn) return { status: 401, body: { error: "Not signed in" } };
      if (url.includes("/settings")) return { body: baseSettings };
      return { body: emptyQueue };
    });
    return { expire: () => (signedIn = false) };
  }

  it("shows the login screen, rejects a wrong password, then lets you in", async () => {
    authServer({ password: "letmein123" });
    const user = userEvent.setup();
    render(<App />);

    const field = await screen.findByLabelText("Password");
    await user.type(field, "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password");
    expect(field).toHaveValue("");

    await user.type(field, "letmein123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("returns to the login screen when the session stops working", async () => {
    const server = authServer({ password: "x", signedIn: true });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();

    server.expire();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  });

  it("signs out from Settings", async () => {
    authServer({ password: "x", signedIn: true });
    window.location.hash = "#/settings";
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Sign out on this device" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/auth/logout"))).toBe(true);
  });
});
