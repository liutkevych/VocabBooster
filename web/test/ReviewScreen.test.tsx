import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewScreen } from "../src/ReviewScreen";
import type { Queue, QueueCard } from "../src/api";
import { spoken } from "./setup";

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const preview = { 1: inMin(1.1), 2: inMin(6), 3: inMin(10), 4: inMin(5 * 24 * 60) };

const cat: QueueCard = {
  id: "c1",
  word_id: "w1",
  direction: "en_uk",
  state: 0,
  front: { text: "cat", lang: "en" },
  back: { text: "кіт", lang: "uk" },
  preview,
};
const dog: QueueCard = {
  id: "c2",
  word_id: "w2",
  direction: "uk_en",
  state: 2,
  front: { text: "собака", lang: "uk" },
  back: { text: "dog", lang: "en" },
  preview,
};

const queue = (cards: QueueCard[], next_due_at: string | null = null): Queue => ({
  cards,
  counts: { new: cards.filter((c) => c.state === 0).length, learning: 0, review: cards.filter((c) => c.state === 2).length },
  new_limit: { per_day: 20, introduced_today: 0 },
  next_due_at,
});

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
let reviews: Array<Record<string, unknown>>;

function mockFetch(handler: Handler) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") reviews.push(JSON.parse(String(init.body)));
      const { status = 200, body } = await handler(url, init);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
}

beforeEach(() => {
  reviews = [];
  spoken.length = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("ReviewScreen", () => {
  it("shows the front, reveals on tap, rates, and moves to the next card", async () => {
    const queues = [queue([cat, dog])];
    mockFetch((url, init) => (init?.method === "POST" ? { body: { card: {} } } : { body: queues.shift() ?? queue([]) }));
    const user = userEvent.setup();
    render(<ReviewScreen />);

    expect(await screen.findByText("cat")).toBeInTheDocument();
    expect(screen.getByText("English → Ukrainian")).toBeInTheDocument();
    expect(screen.queryByText("кіт")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /good/i })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("card"));
    expect(screen.getByText("кіт")).toBeInTheDocument();
    // Interval labels from the server's preview
    expect(screen.getByRole("button", { name: /again\s*1m/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /easy\s*5d/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /good/i }));
    expect(await screen.findByText("собака")).toBeInTheDocument();
    await waitFor(() => expect(reviews).toHaveLength(1));
    expect(reviews[0]).toMatchObject({ card_id: "c1", rating: 3 });
    expect(reviews[0].client_review_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("speaks English automatically: on the front for EN→UK, on reveal for UK→EN", async () => {
    mockFetch((_url, init) => (init?.method === "POST" ? { body: {} } : { body: queue([cat, dog]) }));
    const user = userEvent.setup();
    render(<ReviewScreen />);

    await screen.findByText("cat");
    await waitFor(() => expect(spoken).toEqual(["cat"]));

    await user.keyboard(" ");
    await user.keyboard("4");
    await screen.findByText("собака");
    expect(spoken).toEqual(["cat"]); // Ukrainian front is not spoken

    await user.keyboard(" ");
    await waitFor(() => expect(spoken).toEqual(["cat", "dog"]));

    await user.click(screen.getByRole("button", { name: /play pronunciation of dog/i }));
    expect(spoken).toEqual(["cat", "dog", "dog"]);
  });

  it("can turn sound off, and remembers it", async () => {
    mockFetch(() => ({ body: queue([cat]) }));
    const user = userEvent.setup();
    render(<ReviewScreen />);
    await screen.findByText("cat");
    await user.click(screen.getByRole("button", { name: "Sound on" }));
    expect(screen.getByRole("button", { name: "Sound off" })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("vocab.audio")).toBe("off");
  });

  it("shows when the next card is due once everything is done", async () => {
    const queues = [queue([cat]), queue([], inMin(7))];
    mockFetch((_url, init) => (init?.method === "POST" ? { body: {} } : { body: queues.shift() ?? queue([]) }));
    const user = userEvent.setup();
    render(<ReviewScreen />);

    await screen.findByText("cat");
    await user.keyboard(" ");
    await user.keyboard("1");
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText(/Next card in 7 min/)).toBeInTheDocument();
  });

  it("offers a retry when a review can't be saved, reusing the same ID", async () => {
    let failing = true;
    const queues = [queue([cat, dog])];
    mockFetch((_url, init) => {
      if (init?.method === "POST") return failing ? { status: 400, body: { error: "nope" } } : { body: {} };
      return { body: queues.shift() ?? queue([]) };
    });
    const user = userEvent.setup();
    render(<ReviewScreen />);

    await screen.findByText("cat");
    await user.keyboard(" ");
    await user.keyboard("3");
    expect(await screen.findByRole("alert")).toHaveTextContent("1 review wasn't saved");

    failing = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(reviews).toHaveLength(2);
    expect(reviews[1].client_review_id).toBe(reviews[0].client_review_id);
  });

  it("shows an error with a way to try again when the queue can't load", async () => {
    let fail = true;
    mockFetch(() => (fail ? { status: 500, body: { error: "Internal error" } } : { body: queue([cat]) }));
    const user = userEvent.setup();
    render(<ReviewScreen />);

    expect(await screen.findByText("Couldn't load cards.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("cat")).toBeInTheDocument();
  });
});
