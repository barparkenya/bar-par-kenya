import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export type Learner = {
  id: string;
  kind: "guest" | "registered";
  displayName: string | null;
  email: string | null;
  examDate: string | null;
  createdAt: string;
};

export type Deck = {
  subjectId: string;
  slug: string;
  unitCode: string;
  name: string;
  total: number;
  due: number;
  newCount: number;
  nextDueAt: string | null;
};

export type CardReview = {
  flashcardId: string;
  rating: "again" | "hard" | "good" | "easy";
  state: "new" | "learning" | "review";
  reviewCount: number;
  lapses: number;
  intervalDays: number;
  easePermille: number;
  dueAt: string;
  lastReviewedAt: string;
};

export type StudyCard = {
  id: string;
  topicId: string;
  subjectId: string;
  unitCode: string;
  subjectName: string;
  topicName: string;
  front: string;
  back: string;
  source: string | null;
  review: CardReview | null;
};

export type CardSession = {
  cards: StudyCard[];
  total: number;
  nextDueAt: string | null;
  offline?: boolean;
};

export type MindMapSummary = {
  subjectId: string;
  slug: string;
  unitCode: string;
  name: string;
  nodeCount: number;
};

export type MindMapNode = {
  id: string;
  key: string;
  parentKey: string | null;
  label: string;
  kind: "unit" | "topic" | "issue";
  depth: number;
  position: number;
  topicId?: string | null;
  cardCount?: number;
};

export type MindMapData = MindMapSummary & { nodes: MindMapNode[] };

export type PendingReview = {
  id: string;
  cardId: string;
  rating: CardReview["rating"];
  createdAt: string;
};

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000";
const TOKEN_KEY = "barpar.token";
const DEVICE_KEY = "barpar.device";
const KIND_KEY = "barpar.kind";
const DECK_CACHE_KEY = "barpar.cache.decks";
const REVIEW_QUEUE_KEY = "barpar.pendingReviews";
const LAST_DECK_KEY = "barpar.lastDeck";
const HAS_REVIEWED_KEY = "barpar.hasReviewed";
const LEARNER_CACHE_KEY = "barpar.cache.learner";

let token: string | null = null;
let sessionPromise: Promise<string> | null = null;
let offlineCache = false;

const storage = {
  async get(key: string) {
    if (Platform.OS === "web") {
      try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
    }
    try { return await SecureStore.getItemAsync(key); } catch { return null; }
  },
  async set(key: string, value: string) {
    if (Platform.OS === "web") {
      try { globalThis.localStorage?.setItem(key, value); } catch {}
      return;
    }
    try { await SecureStore.setItemAsync(key, value); } catch {}
  },
  async remove(key: string) {
    if (Platform.OS === "web") {
      try { globalThis.localStorage?.removeItem(key); } catch {}
      return;
    }
    try { await SecureStore.deleteItemAsync(key); } catch {}
  },
};

async function readJson<T>(key: string): Promise<T | null> {
  const value = await storage.get(key);
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

async function writeJson(key: string, value: unknown) {
  await storage.set(key, JSON.stringify(value));
}

async function raw(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body: any = null;
  if (response.status !== 204) {
    const text = await response.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return body?.data ?? body;
}

async function setAuth(payload: { accessToken: string; learner: Learner }) {
  token = String(payload.accessToken);
  await Promise.all([
    storage.set(TOKEN_KEY, token),
    storage.set(KIND_KEY, payload.learner.kind),
    writeJson(LEARNER_CACHE_KEY, payload.learner),
  ]);
  return payload;
}

async function ensureSession() {
  if (token) return token;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    token = await storage.get(TOKEN_KEY);
    if (token) return token;

    let deviceId = await storage.get(DEVICE_KEY);
    if (!deviceId) {
      deviceId = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await storage.set(DEVICE_KEY, deviceId);
    }

    const auth = await raw("/v1/auth/guest", {
      method: "POST",
      body: JSON.stringify({ deviceId }),
    }) as { accessToken: string; learner: Learner };
    await setAuth(auth);
    return auth.accessToken;
  })();

  try {
    return await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

async function authed<T>(path: string, init: RequestInit = {}): Promise<T> {
  await ensureSession();
  try {
    return await raw(path, init) as T;
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 401) {
      const kind = await storage.get(KIND_KEY);
      token = null;
      await storage.remove(TOKEN_KEY);
      if (kind === "registered") throw new Error("Session expired. Sign in again.");
      await ensureSession();
      return await raw(path, init) as T;
    }
    throw error;
  }
}

const sessionCacheKey = (subjectId?: string, topicId?: string) =>
  `barpar.cache.session.${topicId ? `topic-${topicId}` : subjectId ? `subject-${subjectId}` : "all"}`;

async function getPendingReviews() {
  return (await readJson<PendingReview[]>(REVIEW_QUEUE_KEY)) ?? [];
}

async function savePendingReviews(items: PendingReview[]) {
  await writeJson(REVIEW_QUEUE_KEY, items);
}

export const api = {
  async getMe() {
    try {
      const learner = await authed<Learner>("/v1/me");
      offlineCache = false;
      await writeJson(LEARNER_CACHE_KEY, learner);
      return learner;
    } catch (error) {
      const cached = await readJson<Learner>(LEARNER_CACHE_KEY);
      if (cached) {
        offlineCache = true;
        return cached;
      }
      throw error;
    }
  },

  async registerAccount(input: { displayName: string; email: string; password: string }) {
    await ensureSession();
    const payload = await raw("/v1/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }) as { accessToken: string; learner: Learner };
    return setAuth(payload);
  },

  async login(input: { email: string; password: string }) {
    token = null;
    const payload = await raw("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }) as { accessToken: string; learner: Learner };
    return setAuth(payload);
  },

  async logout() {
    const sync = await api.syncPendingReviews();
    if (sync.pending > 0) throw new Error("Connect before signing out so pending reviews can sync.");
    token = null;
    await Promise.all([
      storage.remove(TOKEN_KEY),
      storage.remove(KIND_KEY),
      storage.remove(DEVICE_KEY),
      storage.remove(LEARNER_CACHE_KEY),
      storage.remove(DECK_CACHE_KEY),
      storage.remove(REVIEW_QUEUE_KEY),
      storage.remove(LAST_DECK_KEY),
      storage.remove(HAS_REVIEWED_KEY),
    ]);
  },

  async listDecks() {
    try {
      const decks = await authed<Deck[]>("/v1/decks");
      offlineCache = false;
      await writeJson(DECK_CACHE_KEY, decks);
      return decks;
    } catch (error) {
      const cached = await readJson<Deck[]>(DECK_CACHE_KEY);
      if (cached) {
        offlineCache = true;
        return cached;
      }
      throw error;
    }
  },

  async startCardSession(subjectId?: string, topicId?: string): Promise<CardSession> {
    const cacheKey = sessionCacheKey(subjectId, topicId);
    try {
      await api.syncPendingReviews();
      const session = await authed<CardSession>("/v1/cards/session", {
        method: "POST",
        body: JSON.stringify({
          ...(subjectId ? { subjectId } : {}),
          ...(topicId ? { topicId } : {}),
          limit: 30,
        }),
      });
      offlineCache = false;
      await writeJson(cacheKey, session);
      return session;
    } catch (error) {
      const cached = await readJson<CardSession>(cacheKey);
      if (cached?.cards?.length) {
        const pending = await getPendingReviews();
        const pendingIds = new Set(pending.map((item) => item.cardId));
        const cards = cached.cards.filter((card) => !pendingIds.has(card.id));
        offlineCache = true;
        return { ...cached, cards, total: cards.length, offline: true };
      }
      throw error;
    }
  },

  async queueReview(cardId: string, rating: CardReview["rating"]) {
    const pending = await getPendingReviews();
    const item: PendingReview = {
      id: globalThis.crypto?.randomUUID?.() || `review-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cardId,
      rating,
      createdAt: new Date().toISOString(),
    };
    pending.push(item);
    await Promise.all([
      savePendingReviews(pending),
      storage.set(HAS_REVIEWED_KEY, "true"),
    ]);
    return item;
  },

  async undoQueuedReview(id: string) {
    const pending = await getPendingReviews();
    const next = pending.filter((item) => item.id !== id);
    const removed = next.length !== pending.length;
    if (removed) await savePendingReviews(next);
    return removed;
  },

  async syncPendingReviews() {
    const pending = await getPendingReviews();
    if (!pending.length) return { pending: 0, synced: 0 };

    await ensureSession();
    let remaining = [...pending];
    let synced = 0;

    for (const item of pending) {
      try {
        await raw(`/v1/cards/${item.cardId}/review`, {
          method: "POST",
          body: JSON.stringify({ rating: item.rating }),
        });
        synced += 1;
        remaining = remaining.filter((queued) => queued.id !== item.id);
        await savePendingReviews(remaining);
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        if (status === 400 || status === 404) {
          remaining = remaining.filter((queued) => queued.id !== item.id);
          await savePendingReviews(remaining);
          continue;
        }
        break;
      }
    }

    return { pending: remaining.length, synced };
  },

  async pendingReviewCount() {
    return (await getPendingReviews()).length;
  },

  async listMindMaps() {
    const key = "barpar.cache.maps";
    try {
      const maps = await raw("/v1/mind-maps") as MindMapSummary[];
      offlineCache = false;
      await writeJson(key, maps);
      return maps;
    } catch (error) {
      const cached = await readJson<MindMapSummary[]>(key);
      if (cached) {
        offlineCache = true;
        return cached;
      }
      throw error;
    }
  },

  async getMindMap(slug: string) {
    const key = `barpar.cache.map.${slug}`;
    try {
      const map = await raw(`/v1/mind-maps/${encodeURIComponent(slug)}`) as MindMapData;
      offlineCache = false;
      await writeJson(key, map);
      return map;
    } catch (error) {
      const cached = await readJson<MindMapData>(key);
      if (cached) {
        offlineCache = true;
        return cached;
      }
      throw error;
    }
  },

  async setLastDeck(subjectId: string) {
    await storage.set(LAST_DECK_KEY, subjectId);
  },

  async getLastDeck() {
    return storage.get(LAST_DECK_KEY);
  },

  async hasReviewed() {
    return (await storage.get(HAS_REVIEWED_KEY)) === "true";
  },

  isUsingOfflineCache() {
    return offlineCache;
  },
};
