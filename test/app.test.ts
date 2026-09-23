import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { fixtureIds, MemoryStore } from "./memory-store.js";
import type { MediaStorage } from "../src/media-storage.js";

function setup() {
  const store = new MemoryStore();
  const app = createApp({
    store,
    auth: createAuth("test-secret-that-is-at-least-32-characters-long"),
    corsOrigins: ["http://localhost:8081"],
  });
  return { app, store };
}

async function guest(app: ReturnType<typeof createApp>) {
  const response = await app.request("/v1/auth/guest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "test-device-1234" }),
  });
  const body = await response.json() as { data: { accessToken: string; learner: { id: string } } };
  return { token: body.data.accessToken, learnerId: body.data.learner.id };
}

describe("Bar Par Kenya API", () => {
  it("reports service health", async () => {
    const { app } = setup();
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "bar-par-kenya-api" });
  });

  it("supports HEAD monitoring on the API root and health endpoint", async () => {
    const { app } = setup();
    const root = await app.request("/", { method: "HEAD" });
    const health = await app.request("/health", { method: "HEAD" });
    expect(root.status).toBe(200);
    expect(health.status).toBe(200);
    expect(await root.text()).toBe("");
    expect(await health.text()).toBe("");
  });

  it("lets a guest experience the full practice loop without registering", async () => {
    const { app } = setup();
    const { token } = await guest(app);
    const authorization = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const flashcardsResponse = await app.request("/v1/flashcards", { headers: authorization });
    expect(flashcardsResponse.status).toBe(200);
    const flashcardsBody = await flashcardsResponse.json() as { data: Array<Record<string, unknown>> };
    expect(flashcardsBody.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ front: "When approaching a Civil Litigation problem, what should you identify first?", back: { answer: "The procedural issue and relief sought", explanation: "Start by identifying the procedural issue and the relief being sought; that frames the rest of the analysis." } }),
    ]));

    const firstCard = flashcardsBody.data[0] as { id: string; review: unknown };
    expect(firstCard.review).toBeNull();
    const reviewResponse = await app.request(`/v1/flashcards/${firstCard.id}/review`, {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ rating: "known" }),
    });
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toMatchObject({ data: { questionId: firstCard.id, rating: "known", reviewCount: 1 } });
    const reviewedCardsResponse = await app.request("/v1/flashcards", { headers: authorization });
    expect((await reviewedCardsResponse.json() as { data: Array<{ id: string; review: { rating: string } | null }> }).data.find((card) => card.id === firstCard.id)?.review).toMatchObject({ rating: "known" });

    const subjectResponse = await app.request("/v1/subjects");
    expect(subjectResponse.status).toBe(200);
    expect((await subjectResponse.json() as { data: unknown[] }).data).toHaveLength(9);

    const sessionResponse = await app.request("/v1/practice/sessions", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ topicId: fixtureIds.topicId, questionCount: 2, mode: "practice" }),
    });
    expect(sessionResponse.status).toBe(201);
    const sessionBody = await sessionResponse.json() as {
      data: { id: string; currentQuestion: Record<string, unknown> };
    };
    expect(sessionBody.data.currentQuestion).not.toHaveProperty("correctOptionId");
    expect(sessionBody.data.currentQuestion).not.toHaveProperty("explanation");

    const answerResponse = await app.request(`/v1/practice/sessions/${sessionBody.data.id}/answer`, {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ questionId: fixtureIds.firstQuestionId, selectedOptionId: "a" }),
    });
    expect(answerResponse.status).toBe(200);
    expect(await answerResponse.json()).toMatchObject({
      data: { isCorrect: true, correctOptionId: "a", session: { correctCount: 1, currentIndex: 1 } },
    });

    const progressResponse = await app.request("/v1/progress", { headers: authorization });
    expect(await progressResponse.json()).toMatchObject({
      data: { answered: 1, correct: 1, accuracy: 100 },
    });
  });


  it("serves deck sessions, four-way card reviews, and mind maps", async () => {
    const { app } = setup();
    const { token } = await guest(app);
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

    const decksResponse = await app.request("/v1/decks", { headers });
    expect(decksResponse.status).toBe(200);
    const decks = await decksResponse.json() as { data: Array<{ subjectId: string; unitCode: string }> };
    expect(decks.data[0]).toMatchObject({ unitCode: "ATP100" });

    const sessionResponse = await app.request("/v1/cards/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ subjectId: decks.data[0]!.subjectId, limit: 2 }),
    });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json() as { data: { cards: Array<{ id: string; front: string }>; total: number } };
    expect(session.data.total).toBeGreaterThan(0);
    expect(session.data.cards[0]?.front).toBeTruthy();

    const reviewResponse = await app.request("/v1/cards/" + session.data.cards[0]!.id + "/review", {
      method: "POST",
      headers,
      body: JSON.stringify({ rating: "good" }),
    });
    expect(reviewResponse.status).toBe(200);
    expect(await reviewResponse.json()).toMatchObject({
      data: { rating: "good", state: "review", reviewCount: 1 },
    });

    const mapsResponse = await app.request("/v1/mind-maps");
    expect(mapsResponse.status).toBe(200);
    const maps = await mapsResponse.json() as { data: Array<{ slug: string; unitCode: string }> };
    expect(maps.data[0]).toMatchObject({ slug: "civil-litigation", unitCode: "ATP100" });

    const mapResponse = await app.request("/v1/mind-maps/civil-litigation");
    expect(mapResponse.status).toBe(200);
    expect(await mapResponse.json()).toMatchObject({
      data: {
        unitCode: "ATP100",
        nodes: expect.arrayContaining([
          expect.objectContaining({ kind: "unit" }),
          expect.objectContaining({ kind: "topic" }),
          expect.objectContaining({ kind: "issue" }),
        ]),
      },
    });
  });

  it("upgrades a guest without losing its learner identity, then supports login", async () => {
    const { app } = setup();
    const { token, learnerId } = await guest(app);
    const registration = await app.request("/v1/auth/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "learner@example.com",
        password: "safe-password-123",
        displayName: "Amina",
      }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { data: { learner: { id: string; kind: string } } };
    expect(registered.data.learner).toMatchObject({ id: learnerId, kind: "registered" });

    const login = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "LEARNER@example.com", password: "safe-password-123" }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ data: { learner: { id: learnerId } } });
  });

  it("rejects protected requests without a token", async () => {
    const { app } = setup();
    const response = await app.request("/v1/progress");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("stores opt-in notification settings instead of enabling notifications by default", async () => {
    const { app } = setup();
    const { token } = await guest(app);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const initial = await app.request("/v1/notification-preferences", { headers });
    expect(await initial.json()).toMatchObject({ data: { enabled: false, preferredHour: 19 } });

    const updated = await app.request("/v1/notification-preferences", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: true, preferredHour: 20 }),
    });
    expect(await updated.json()).toMatchObject({ data: { enabled: true, preferredHour: 20 } });
  });

  it("protects R2 media grants behind the admin key and generates safe object keys", async () => {
    const store = new MemoryStore();
    const mediaStorage: MediaStorage = {
      async createUploadGrant(input) {
        return {
          objectKey: input.objectKey,
          uploadUrl: "https://example.invalid/signed-upload",
          expiresAt: "2030-01-01T00:00:00.000Z",
          requiredHeaders: { "Content-Type": input.contentType },
        };
      },
      async createDownloadGrant(input) {
        return {
          objectKey: input.objectKey,
          downloadUrl: "https://example.invalid/signed-download",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
    };
    const app = createApp({
      store,
      auth: createAuth("test-secret-that-is-at-least-32-characters-long"),
      corsOrigins: ["http://localhost:8081"],
      mediaStorage,
      adminApiKey: "admin-secret-that-is-at-least-32-characters",
    });
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "resources", contentType: "application/pdf", sizeBytes: 1024 }),
    };
    expect((await app.request("/v1/admin/media/upload-url", request)).status).toBe(401);

    const allowed = await app.request("/v1/admin/media/upload-url", {
      ...request,
      headers: {
        ...request.headers,
        "X-Admin-Key": "admin-secret-that-is-at-least-32-characters",
      },
    });
    expect(allowed.status).toBe(201);
    const body = await allowed.json() as { data: { objectKey: string; uploadUrl: string } };
    expect(body.data.objectKey).toMatch(/^resources\/[0-9a-f-]+\.pdf$/);
    expect(body.data.uploadUrl).toBe("https://example.invalid/signed-upload");
  });
});
