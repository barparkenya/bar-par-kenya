import { randomUUID, timingSafeEqual } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthClaims, AuthService } from "./auth.js";
import type { Learner, PracticeSession, Question } from "./domain.js";
import type { MediaStorage } from "./media-storage.js";
import type { Store } from "./store.js";
import { ConflictError, NotFoundError, ValidationError } from "./store.js";

interface AppEnv {
  Variables: {
    auth: AuthClaims;
  };
}

export interface AppDependencies {
  store: Store;
  auth: AuthService;
  corsOrigins: string[];
  mediaStorage?: MediaStorage;
  adminApiKey?: string;
}

const emailSchema = z.string().email().transform((value) => value.toLowerCase());
const uuidSchema = z.string().uuid();

const publicQuestion = (question: Question) => ({
  id: question.id,
  topicId: question.topicId,
  prompt: question.prompt,
  options: question.options,
  difficulty: question.difficulty,
});

const publicFlashcard = (question: Question) => ({
  id: question.id,
  topicId: question.topicId,
  front: question.prompt,
  back: {
    answer: question.options.find((option) => option.id === question.correctOptionId)?.text ?? "",
    explanation: question.explanation,
  },
  difficulty: question.difficulty,
});

async function sessionResponse(store: Store, session: PracticeSession) {
  const currentQuestionId = session.questionIds[session.currentIndex];
  const question = currentQuestionId ? await store.getQuestion(currentQuestionId) : null;
  return {
    id: session.id,
    mode: session.mode,
    status: session.status,
    currentIndex: session.currentIndex,
    questionCount: session.questionIds.length,
    correctCount: session.correctCount,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    currentQuestion: question ? publicQuestion(question) : null,
  };
}

function authPayload(learner: Learner, accessToken: string) {
  return { accessToken, tokenType: "Bearer", learner };
}

export function createApp({ store, auth, corsOrigins, mediaStorage, adminApiKey }: AppDependencies) {
  const app = new Hono<AppEnv>();

  app.use("*", secureHeaders());
  app.use("*", cors({
    origin: (origin) => corsOrigins.includes(origin) ? origin : corsOrigins[0] ?? origin,
    allowHeaders: ["Authorization", "Content-Type", "X-Admin-Key", "X-Request-Id"],
    allowMethods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }));

  const requireAuth = createMiddleware<AppEnv>(async (context, next) => {
    const header = context.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return context.json({ error: { code: "unauthorized", message: "Bearer token required" } }, 401);
    }
    try {
      const claims = await auth.verify(header.slice(7));
      const learner = await store.getLearner(claims.learnerId);
      if (!learner) throw new Error("Learner not found");
      context.set("auth", claims);
      await next();
    } catch {
      return context.json({ error: { code: "unauthorized", message: "Invalid or expired access token" } }, 401);
    }
  });

  const requireAdmin = createMiddleware<AppEnv>(async (context, next) => {
    if (!adminApiKey || !mediaStorage) {
      return context.json({ error: { code: "not_configured", message: "Media administration is not configured" } }, 503);
    }
    const supplied = context.req.header("X-Admin-Key") ?? "";
    const expectedBuffer = Buffer.from(adminApiKey);
    const suppliedBuffer = Buffer.from(supplied);
    if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
      return context.json({ error: { code: "unauthorized", message: "Valid admin key required" } }, 401);
    }
    await next();
  });

  app.get("/", (context) => context.json({
    status: "ok",
    service: "bar-par-kenya-api",
  }));
  app.on("HEAD", "/", (context) => context.body(null, 200));

  app.get("/health", (context) => context.json({
    status: "ok",
    service: "bar-par-kenya-api",
    timestamp: new Date().toISOString(),
  }));
  app.on("HEAD", "/health", (context) => context.body(null, 200));

  app.post("/v1/auth/guest", zValidator("json", z.object({
    deviceId: z.string().min(8).max(200).optional(),
  }).default({})), async (context) => {
    const { deviceId } = context.req.valid("json");
    const learner = await store.createGuest(deviceId);
    const accessToken = await auth.sign({ learnerId: learner.id, kind: learner.kind });
    return context.json({ data: authPayload(learner, accessToken) }, 201);
  });

  app.post("/v1/auth/register", zValidator("json", z.object({
    email: emailSchema,
    password: z.string().min(10).max(128),
    displayName: z.string().trim().min(2).max(80),
  })), async (context) => {
    const body = context.req.valid("json");
    const header = context.req.header("Authorization");
    let learnerId: string | undefined;
    if (header?.startsWith("Bearer ")) {
      try {
        learnerId = (await auth.verify(header.slice(7))).learnerId;
      } catch {
        return context.json({ error: { code: "unauthorized", message: "Invalid access token" } }, 401);
      }
    }
    const passwordHash = await hash(body.password, 11);
    const learner = await store.registerLearner({
      ...(learnerId ? { learnerId } : {}),
      email: body.email,
      passwordHash,
      displayName: body.displayName,
    });
    const accessToken = await auth.sign({ learnerId: learner.id, kind: learner.kind });
    return context.json({ data: authPayload(learner, accessToken) }, 201);
  });

  app.post("/v1/auth/login", zValidator("json", z.object({
    email: emailSchema,
    password: z.string().min(1).max(128),
  })), async (context) => {
    const body = context.req.valid("json");
    const credential = await store.findUserByEmail(body.email);
    if (!credential || !(await compare(body.password, credential.passwordHash))) {
      return context.json({ error: { code: "invalid_credentials", message: "Email or password is incorrect" } }, 401);
    }
    const accessToken = await auth.sign({
      learnerId: credential.learner.id,
      kind: credential.learner.kind,
    });
    return context.json({ data: authPayload(credential.learner, accessToken) });
  });

  app.get("/v1/subjects", async (context) => context.json({ data: await store.listSubjects() }));

  app.get("/v1/subjects/:slug/topics", async (context) => {
    const result = await store.listTopics(context.req.param("slug"));
    if (!result) return context.json({ error: { code: "not_found", message: "Subject not found" } }, 404);
    return context.json({ data: result });
  });

  app.use("/v1/me", requireAuth);
  app.use("/v1/decks", requireAuth);
  app.use("/v1/cards/*", requireAuth);
  app.use("/v1/flashcards", requireAuth);
  app.use("/v1/flashcards/*", requireAuth);
  app.use("/v1/practice/*", requireAuth);
  app.use("/v1/progress", requireAuth);
  app.use("/v1/discovery", requireAuth);
  app.use("/v1/bookmarks", requireAuth);
  app.use("/v1/bookmarks/*", requireAuth);
  app.use("/v1/notification-preferences", requireAuth);
  app.use("/v1/devices/push-token", requireAuth);
  app.use("/v1/admin/*", requireAdmin);

  app.get("/v1/me", async (context) => {
    const learner = await store.getLearner(context.get("auth").learnerId);
    return context.json({ data: learner });
  });


  app.get("/v1/decks", async (context) => context.json({
    data: await store.listDecks(context.get("auth").learnerId),
  }));

  app.post("/v1/cards/session", zValidator("json", z.object({
    subjectId: uuidSchema.optional(),
    topicId: uuidSchema.optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }).refine((value) => !(value.subjectId && value.topicId), {
    message: "Choose either subjectId or topicId, not both",
  })), async (context) => {
    const body = context.req.valid("json");
    const session = await store.createCardSession({
      learnerId: context.get("auth").learnerId,
      ...(body.subjectId ? { subjectId: body.subjectId } : {}),
      ...(body.topicId ? { topicId: body.topicId } : {}),
      limit: body.limit,
    });
    return context.json({ data: session });
  });

  app.post("/v1/cards/:cardId/review", zValidator("json", z.object({
    rating: z.enum(["again", "hard", "good", "easy"]),
  })), async (context) => {
    const cardId = context.req.param("cardId");
    if (!uuidSchema.safeParse(cardId).success) {
      return context.json({ error: { code: "validation_error", message: "Invalid flashcard id" } }, 400);
    }
    return context.json({
      data: await store.reviewCard({
        learnerId: context.get("auth").learnerId,
        flashcardId: cardId,
        rating: context.req.valid("json").rating,
      }),
    });
  });

  app.get("/v1/mind-maps", async (context) => context.json({ data: await store.listMindMaps() }));

  app.get("/v1/mind-maps/:slug", async (context) => {
    const map = await store.getMindMap(context.req.param("slug"));
    if (!map) return context.json({ error: { code: "not_found", message: "Mind map not found" } }, 404);
    return context.json({ data: map });
  });

  app.get("/v1/flashcards", zValidator("query", z.object({
    subjectId: uuidSchema.optional(),
    topicId: uuidSchema.optional(),
  })), async (context) => {
    const cards = await store.listFlashcards(context.req.valid("query"));
    const reviews = await store.getFlashcardReviews(context.get("auth").learnerId);
    const reviewByQuestionId = new Map(reviews.map((review) => [review.questionId, review]));
    return context.json({ data: cards.map((card) => ({
      ...publicFlashcard(card),
      review: reviewByQuestionId.get(card.id) ?? null,
    })) });
  });

  app.post("/v1/flashcards/:questionId/review", zValidator("json", z.object({
    rating: z.enum(["again", "known"]),
  })), async (context) => {
    const questionId = context.req.param("questionId");
    if (!uuidSchema.safeParse(questionId).success) {
      return context.json({ error: { code: "validation_error", message: "Invalid flashcard id" } }, 400);
    }
    return context.json({ data: await store.reviewFlashcard({
      learnerId: context.get("auth").learnerId,
      questionId,
      rating: context.req.valid("json").rating,
    }) });
  });

  app.post("/v1/practice/sessions", zValidator("json", z.object({
    subjectId: uuidSchema.optional(),
    topicId: uuidSchema.optional(),
    questionCount: z.number().int().min(1).max(50).default(10),
    mode: z.enum(["practice", "timed"]).default("practice"),
  }).refine((value) => !(value.subjectId && value.topicId), {
    message: "Choose either subjectId or topicId, not both",
  })), async (context) => {
    const body = context.req.valid("json");
    const session = await store.createPracticeSession({
      learnerId: context.get("auth").learnerId,
      ...(body.subjectId ? { subjectId: body.subjectId } : {}),
      ...(body.topicId ? { topicId: body.topicId } : {}),
      questionCount: body.questionCount,
      mode: body.mode,
    });
    return context.json({ data: await sessionResponse(store, session) }, 201);
  });

  app.get("/v1/practice/sessions/:sessionId", async (context) => {
    const sessionId = context.req.param("sessionId");
    if (!uuidSchema.safeParse(sessionId).success) {
      return context.json({ error: { code: "validation_error", message: "Invalid session id" } }, 400);
    }
    const session = await store.getPracticeSession(sessionId, context.get("auth").learnerId);
    if (!session) return context.json({ error: { code: "not_found", message: "Practice session not found" } }, 404);
    return context.json({ data: await sessionResponse(store, session) });
  });

  app.post("/v1/practice/sessions/:sessionId/answer", zValidator("json", z.object({
    questionId: uuidSchema,
    selectedOptionId: z.string().min(1).max(40),
  })), async (context) => {
    const body = context.req.valid("json");
    const result = await store.answerQuestion({
      sessionId: context.req.param("sessionId"),
      learnerId: context.get("auth").learnerId,
      questionId: body.questionId,
      selectedOptionId: body.selectedOptionId,
    });
    return context.json({
      data: {
        isCorrect: result.isCorrect,
        correctOptionId: result.correctOptionId,
        explanation: result.explanation,
        session: await sessionResponse(store, result.session),
        nextQuestion: result.nextQuestion ? publicQuestion(result.nextQuestion) : null,
      },
    });
  });

  app.get("/v1/progress", async (context) => context.json({
    data: await store.getProgress(context.get("auth").learnerId),
  }));

  app.get("/v1/discovery", async (context) => {
    const learnerId = context.get("auth").learnerId;
    const [progress, saved] = await Promise.all([
      store.getProgress(learnerId),
      store.listBookmarks(learnerId),
    ]);
    return context.json({
      data: [
        {
          id: "first-practice",
          title: "Try a short practice set",
          description: "Answer a few questions and get explanations immediately.",
          route: "/practice/new",
          completed: progress.answered > 0,
        },
        {
          id: "save-question",
          title: "Save a question for review",
          description: "Build a focused revision list from questions you want to revisit.",
          route: "/bookmarks",
          completed: saved.length > 0,
        },
        {
          id: "protect-progress",
          title: "Protect your progress",
          description: "Create an account only when you are ready to sync across devices.",
          route: "/register",
          completed: context.get("auth").kind === "registered",
        },
      ],
    });
  });

  app.get("/v1/bookmarks", async (context) => {
    const saved = await store.listBookmarks(context.get("auth").learnerId);
    return context.json({ data: saved.map(publicQuestion) });
  });

  app.post("/v1/bookmarks/:questionId", async (context) => {
    await store.addBookmark(context.get("auth").learnerId, context.req.param("questionId"));
    return context.body(null, 204);
  });

  app.delete("/v1/bookmarks/:questionId", async (context) => {
    await store.removeBookmark(context.get("auth").learnerId, context.req.param("questionId"));
    return context.body(null, 204);
  });

  app.get("/v1/notification-preferences", async (context) => context.json({
    data: await store.getNotificationPreferences(context.get("auth").learnerId),
  }));

  app.patch("/v1/notification-preferences", zValidator("json", z.object({
    enabled: z.boolean().optional(),
    studyReminders: z.boolean().optional(),
    streakReminders: z.boolean().optional(),
    preferredHour: z.number().int().min(0).max(23).optional(),
    timezone: z.string().min(1).max(80).optional(),
  })), async (context) => {
    const body = context.req.valid("json");
    const updates = {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.studyReminders !== undefined ? { studyReminders: body.studyReminders } : {}),
      ...(body.streakReminders !== undefined ? { streakReminders: body.streakReminders } : {}),
      ...(body.preferredHour !== undefined ? { preferredHour: body.preferredHour } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
    };
    return context.json({
      data: await store.updateNotificationPreferences(context.get("auth").learnerId, updates),
    });
  });

  app.post("/v1/devices/push-token", zValidator("json", z.object({
    token: z.string().min(10).max(500),
    platform: z.enum(["android", "ios", "web"]),
  })), async (context) => {
    const body = context.req.valid("json");
    await store.savePushToken(context.get("auth").learnerId, body.token, body.platform);
    return context.body(null, 204);
  });

  const mediaTypes = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
  } as const;

  app.post("/v1/admin/media/upload-url", zValidator("json", z.object({
    scope: z.enum(["questions", "resources", "subjects"]),
    contentType: z.enum(Object.keys(mediaTypes) as [keyof typeof mediaTypes, ...(keyof typeof mediaTypes)[]]),
    sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
  })), async (context) => {
    const body = context.req.valid("json");
    const extension = mediaTypes[body.contentType];
    const objectKey = `${body.scope}/${randomUUID()}.${extension}`;
    return context.json({
      data: await mediaStorage!.createUploadGrant({
        objectKey,
        contentType: body.contentType,
        expiresInSeconds: 600,
      }),
    }, 201);
  });

  app.get("/v1/admin/media/download-url", zValidator("query", z.object({
    objectKey: z.string().min(1).max(1024).refine(
      (value) => !value.includes("..") && !value.startsWith("/") && /^(questions|resources|subjects)\//.test(value),
      "Invalid media object key",
    ),
  })), async (context) => context.json({
    data: await mediaStorage!.createDownloadGrant({
      objectKey: context.req.valid("query").objectKey,
      expiresInSeconds: 300,
    }),
  }));

  app.notFound((context) => context.json({
    error: { code: "not_found", message: "Route not found" },
  }, 404));

  app.onError((error, context) => {
    if (error instanceof ConflictError) {
      return context.json({ error: { code: "conflict", message: error.message } }, 409);
    }
    if (error instanceof NotFoundError) {
      return context.json({ error: { code: "not_found", message: error.message } }, 404);
    }
    if (error instanceof ValidationError) {
      return context.json({ error: { code: "validation_error", message: error.message } }, 400);
    }
    console.error(error);
    return context.json({ error: { code: "internal_error", message: "An unexpected error occurred" } }, 500);
  });

  return app;
}
