import { Link, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { AppHeader } from "@/components/AppHeader";
import { StatePanel } from "@/components/StatePanel";
import { api, type CardReview, type Deck, type Learner, type PendingReview, type StudyCard } from "@/api";
import { colors, radii, shadow } from "@/theme";

type Phase = "loading" | "ready" | "empty" | "complete" | "error";

function deckStatus(deck: Deck) {
  if (deck.due > 0) return `${deck.due} due`;
  if (deck.newCount > 0) return `${deck.newCount} new`;
  return "Clear";
}

function nextLabel(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function Study() {
  const params = useLocalSearchParams<{ subjectId?: string; topicId?: string }>();
  const { width } = useWindowDimensions();
  const desktop = width >= 920;
  const [phase, setPhase] = useState<Phase>("loading");
  const [decks, setDecks] = useState<Deck[]>([]);
  const [selectedDeck, setSelectedDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const revealMotion = useRef(new Animated.Value(0)).current;
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(0);
  const [learner, setLearner] = useState<Learner | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [repeated, setRepeated] = useState(0);
  const [lastQueued, setLastQueued] = useState<{
    pending: PendingReview;
    cardIndex: number;
    rating: CardReview["rating"];
  } | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const card = cards[index] ?? null;
  const remaining = Math.max(0, cards.length - index);
  const progress = cards.length ? Math.round((index / cards.length) * 100) : 0;
  const dueTotal = useMemo(() => decks.reduce((sum, deck) => sum + deck.due + deck.newCount, 0), [decks]);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    revealMotion.stopAnimation();
    Animated.timing(revealMotion, {
      toValue: revealed ? 1 : 0,
      duration: reduceMotion ? 0 : 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [revealed, reduceMotion, revealMotion]);

  const animatedCardBackground = revealMotion.interpolate({
    inputRange: [0, 0.55, 1],
    outputRange: [colors.ink, colors.ink2, colors.lime],
  });
  const animatedCardScale = revealMotion.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 0.985, 1],
  });
  const animatedCardTilt = revealMotion.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ["0deg", "-1.25deg", "0deg"],
  });
  const frontOpacity = revealMotion.interpolate({
    inputRange: [0, 0.42, 0.5, 1],
    outputRange: [1, 1, 0, 0],
  });
  const frontTranslate = revealMotion.interpolate({
    inputRange: [0, 0.42, 1],
    outputRange: [0, 0, -14],
  });
  const backOpacity = revealMotion.interpolate({
    inputRange: [0, 0.5, 0.58, 1],
    outputRange: [0, 0, 1, 1],
  });
  const backTranslate = revealMotion.interpolate({
    inputRange: [0, 0.58, 1],
    outputRange: [14, 8, 0],
  });

  async function refreshPending() {
    setPending(await api.pendingReviewCount());
  }

  async function flushSoon() {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      setLastQueued(null);
      void api.syncPendingReviews().then(async (result) => {
        setPending(result.pending);
        try {
          const refreshed = await api.listDecks();
          setDecks(refreshed);
          if (selectedDeck) {
            setSelectedDeck(refreshed.find((item) => item.subjectId === selectedDeck.subjectId) ?? selectedDeck);
          }
        } catch {}
      });
    }, 4500);
  }

  async function loadDecks() {
    setPhase("loading");
    try {
      const [data, lastDeckId, me] = await Promise.all([
        api.listDecks(),
        api.getLastDeck(),
        api.getMe().catch(() => null),
      ]);
      setDecks(data);
      setLearner(me);
      await refreshPending();
      const requested = params.subjectId ? data.find((item) => item.subjectId === params.subjectId) : null;
      const remembered = lastDeckId ? data.find((item) => item.subjectId === lastDeckId) : null;
      const first = requested
        ?? remembered
        ?? data.find((item) => item.due + item.newCount > 0)
        ?? data[0]
        ?? null;
      setSelectedDeck(first);
      if (!first) {
        setPhase("empty");
        return;
      }
      await openDeck(first, params.topicId);
    } catch {
      setPhase("error");
    }
  }

  async function openDeck(deck: Deck, topicId?: string) {
    setSelectedDeck(deck);
    setIndex(0);
    setReviewed(0);
    setRepeated(0);
    setRevealed(false);
    setOffline(false);
    setLastQueued(null);
    setPhase("loading");
    await api.setLastDeck(deck.subjectId);
    try {
      const session = await api.startCardSession(topicId ? undefined : deck.subjectId, topicId);
      setCards(session.cards);
      setOffline(Boolean(session.offline));
      setPhase(session.cards.length ? "ready" : "empty");
      await refreshPending();
    } catch {
      setPhase("error");
    }
  }

  async function finishSession() {
    setPhase("complete");
    await refreshPending();
    await flushSoon();
  }

  async function rate(rating: CardReview["rating"]) {
    if (!card || !revealed) return;
    const queued = await api.queueReview(card.id, rating);
    setLastQueued({ pending: queued, cardIndex: index, rating });
    setReviewed((value) => value + 1);
    if (rating === "again") setRepeated((value) => value + 1);
    await refreshPending();

    if (index + 1 >= cards.length) {
      setIndex(cards.length);
      setRevealed(false);
      await finishSession();
      return;
    }

    setIndex((value) => value + 1);
    setRevealed(false);
    await flushSoon();
  }

  async function undoLast() {
    if (!lastQueued) return;
    const undone = await api.undoQueuedReview(lastQueued.pending.id);
    if (!undone) return;
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
    setIndex(lastQueued.cardIndex);
    setRevealed(true);
    setPhase("ready");
    setReviewed((value) => Math.max(0, value - 1));
    if (lastQueued.rating === "again") setRepeated((value) => Math.max(0, value - 1));
    setLastQueued(null);
    await refreshPending();
  }

  useEffect(() => {
    void loadDecks();
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      void api.syncPendingReviews();
    };
  }, [params.subjectId, params.topicId]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handler = (event: KeyboardEvent) => {
      if (phase !== "ready" || !card) return;
      if (event.code === "Space") {
        event.preventDefault();
        setRevealed((value) => !value);
        return;
      }
      if (!revealed) return;
      if (event.key === "1") void rate("again");
      if (event.key === "2") void rate("hard");
      if (event.key === "3") void rate("good");
      if (event.key === "4") void rate("easy");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [phase, card, revealed, index]);

  const nextDeck = decks.find((item) => item.subjectId !== selectedDeck?.subjectId && item.due + item.newCount > 0) ?? null;
  const nextReview = nextLabel(selectedDeck?.nextDueAt ?? null);

  return (
    <View style={styles.page}>
      <AppHeader />
      <ScrollView
        style={styles.bodyScroll}
        contentContainerStyle={[styles.body, desktop && styles.bodyDesktop]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.deckRail, desktop && styles.deckRailDesktop]}>
          <View style={styles.railHead}>
            <Text style={styles.railLabel}>CARDS</Text>
            <Text style={styles.railTotal}>{dueTotal}</Text>
          </View>
          <ScrollView
            horizontal={!desktop}
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={[styles.deckList, !desktop && styles.deckListMobile]}
          >
            {decks.map((deck) => {
              const active = selectedDeck?.subjectId === deck.subjectId;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={deck.subjectId}
                  onPress={() => void openDeck(deck)}
                  style={({ pressed }) => [
                    styles.deckButton,
                    desktop && styles.deckButtonDesktop,
                    active && styles.deckButtonActive,
                    desktop && active && styles.deckButtonActiveDesktop,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.deckButtonTop}>
                    <Text style={[styles.deckCode, active && styles.deckCodeActive, desktop && active && styles.deckCodeActiveDesktop]}>{deck.unitCode}</Text>
                    <Text style={[styles.deckDue, active && styles.deckDueActive, desktop && active && styles.deckDueActiveDesktop]}>{deckStatus(deck)}</Text>
                  </View>
                  <Text numberOfLines={2} style={[styles.deckName, active && styles.deckNameActive, desktop && active && styles.deckNameActiveDesktop]}>{deck.name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View style={styles.stage}>
          <View style={styles.stageTop}>
            <View style={styles.stageIdentity}>
              <Text style={styles.unitCode}>{selectedDeck?.unitCode ?? "ATP"}</Text>
              <Text style={styles.stageTitle}>{selectedDeck?.name ?? "Cards"}</Text>
            </View>
            {phase === "ready" ? (
              <View style={styles.counterWrap}>
                <Text style={styles.counter}>{remaining}</Text>
                <Text style={styles.counterLabel}>LEFT</Text>
              </View>
            ) : null}
          </View>

          {offline || (pending > 0 && !lastQueued) ? (
            <View style={styles.syncBar}>
              <View style={[styles.syncDot, offline && styles.syncDotOffline]} />
              <Text style={styles.syncText}>
                {offline ? "Offline" : `${pending} pending`}
              </Text>
            </View>
          ) : null}

          {phase === "ready" ? (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: (String(progress) + "%") as any }]} />
            </View>
          ) : null}

          {phase === "loading" ? (
            <StatePanel title="Loading…" />
          ) : phase === "error" ? (
            <StatePanel title="Could not load this deck." action="Try again" onPress={() => selectedDeck ? void openDeck(selectedDeck) : void loadDecks()} />
          ) : phase === "empty" ? (
            <View style={styles.completePanel}>
              <Text style={styles.completeKicker}>{selectedDeck?.unitCode}</Text>
              <Text style={styles.completeTitle}>{selectedDeck?.total ? "Clear for now" : "No cards yet"}</Text>
              {nextReview ? <Text style={styles.completeMeta}>Next review · {nextReview}</Text> : null}
              {nextDeck ? (
                <Pressable onPress={() => void openDeck(nextDeck)} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                  <Text style={styles.primaryText}>{nextDeck.unitCode}</Text>
                  <Text style={styles.primaryArrow}>→</Text>
                </Pressable>
              ) : null}
            </View>
          ) : phase === "complete" ? (
            <View style={styles.completePanel}>
              <Text style={styles.completeKicker}>{selectedDeck?.unitCode}</Text>
              <Text style={styles.completeTitle}>Session complete</Text>
              <View style={styles.sessionStats}>
                <View>
                  <Text style={styles.statNumber}>{reviewed}</Text>
                  <Text style={styles.statLabel}>Reviewed</Text>
                </View>
                <View style={styles.statDivider} />
                <View>
                  <Text style={styles.statNumber}>{repeated}</Text>
                  <Text style={styles.statLabel}>Again</Text>
                </View>
              </View>
              {pending > 0 && !lastQueued
                ? <Text style={styles.completeMeta}>{pending} review{pending === 1 ? "" : "s"} will sync when connected</Text>
                : nextReview
                  ? <Text style={styles.completeMeta}>Next review · {nextReview}</Text>
                  : null}
              {lastQueued ? (
                <View style={styles.undoBar}>
                  <Text style={styles.undoText}>Saved as {lastQueued.rating}</Text>
                  <Pressable onPress={() => void undoLast()}><Text style={styles.undoAction}>Undo</Text></Pressable>
                </View>
              ) : null}
              <View style={styles.completeActions}>
                {nextDeck ? (
                  <Pressable onPress={() => void openDeck(nextDeck)} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                    <Text style={styles.primaryText}>Continue · {nextDeck.unitCode}</Text>
                    <Text style={styles.primaryArrow}>→</Text>
                  </Pressable>
                ) : (
                  <Link href="/" asChild>
                    <Pressable style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                      <Text style={styles.primaryText}>Today</Text>
                    </Pressable>
                  </Link>
                )}
                {learner?.kind === "guest" ? (
                  <Link href={{ pathname: "/account", params: { mode: "register" } }} asChild>
                    <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
                      <Text style={styles.secondaryText}>Save progress</Text>
                    </Pressable>
                  </Link>
                ) : null}
              </View>
            </View>
          ) : card ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={revealed ? "Answer shown" : "Reveal answer"}
                onPress={() => setRevealed((value) => !value)}
                style={({ pressed }) => [styles.cardHit, pressed && styles.cardPressed]}
              >
                <Animated.View
                  style={[
                    styles.card,
                    {
                      backgroundColor: animatedCardBackground,
                      transform: [
                        { perspective: 1200 },
                        { scale: animatedCardScale },
                        { rotateX: animatedCardTilt },
                      ],
                    },
                  ]}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.cardFace,
                      {
                        opacity: frontOpacity,
                        transform: [{ translateY: frontTranslate }],
                      },
                    ]}
                  >
                    <View style={styles.cardHeader}>
                      <Text style={styles.cardLabel}>RECALL</Text>
                      <Text style={styles.cardPosition}>{String(index + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}</Text>
                    </View>
                    <View style={styles.cardBody}>
                      <Text style={styles.topic}>{card.topicName}</Text>
                      <Text style={styles.cardText}>{card.front}</Text>
                    </View>
                  </Animated.View>

                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.cardFace,
                      {
                        opacity: backOpacity,
                        transform: [{ translateY: backTranslate }],
                      },
                    ]}
                  >
                    <View style={styles.cardHeader}>
                      <Text style={[styles.cardLabel, styles.cardLabelDark]}>ANSWER</Text>
                      <Text style={[styles.cardPosition, styles.cardLabelDark]}>{String(index + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}</Text>
                    </View>
                    <View style={styles.cardBody}>
                      <Text style={[styles.topic, styles.topicDark]}>{card.topicName}</Text>
                      <Text style={[styles.cardText, styles.cardTextDark]}>{card.back}</Text>
                      {card.source ? <Text style={styles.source}>{card.source}</Text> : null}
                    </View>
                  </Animated.View>
                </Animated.View>
              </Pressable>

              {!revealed ? (
                <Pressable onPress={() => setRevealed(true)} style={({ pressed }) => [styles.reveal, pressed && styles.pressed]}>
                  <Text style={styles.revealText}>Reveal answer</Text>
                </Pressable>
              ) : (
                <View style={styles.ratingGrid}>
                  {(["again", "hard", "good", "easy"] as const).map((rating, ratingIndex) => (
                    <Pressable
                      key={rating}
                      onPress={() => void rate(rating)}
                      style={({ pressed }) => [styles.rateButton, rating === "again" && styles.rateAgain, pressed && styles.ratePressed]}
                    >
                      {Platform.OS === "web" ? <Text style={[styles.rateKey, rating === "again" && styles.rateAgainText]}>{ratingIndex + 1}</Text> : null}
                      <Text style={[styles.rateName, rating === "again" && styles.rateAgainText]}>{rating[0].toUpperCase() + rating.slice(1)}</Text>
                    </Pressable>
                  ))}
                </View>
              )}

              {lastQueued ? (
                <View style={styles.undoBar}>
                  <Text style={styles.undoText}>Saved as {lastQueued.rating}</Text>
                  <Pressable onPress={() => void undoLast()}><Text style={styles.undoAction}>Undo</Text></Pressable>
                </View>
              ) : null}

              {Platform.OS === "web" ? <Text style={styles.keyboard}>Space · 1 · 2 · 3 · 4</Text> : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  bodyScroll: { flex: 1 },
  body: { flexGrow: 1, width: "100%", maxWidth: 1320, alignSelf: "center", padding: 16, paddingBottom: 104, gap: 16 },
  bodyDesktop: { flexDirection: "row", padding: 28, gap: 22 },
  deckRail: { gap: 12 },
  deckRailDesktop: { width: 252, flexShrink: 0, paddingRight: 18, borderRightWidth: 1, borderRightColor: colors.line },
  railHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 },
  railLabel: { color: colors.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  railTotal: { color: colors.ink, fontSize: 11, fontWeight: "900" },
  deckList: { gap: 7 },
  deckListMobile: { paddingRight: 16 },
  deckButton: { minWidth: 210, padding: 14, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  deckButtonDesktop: { minWidth: 0, paddingHorizontal: 4, paddingVertical: 13, borderRadius: 0, borderWidth: 0, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: "transparent" },
  deckButtonActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  deckButtonActiveDesktop: { backgroundColor: "transparent", borderColor: colors.line, borderLeftWidth: 3, borderLeftColor: colors.coral, paddingLeft: 11 },
  deckButtonTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  deckCode: { color: colors.coral, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  deckCodeActive: { color: colors.lime },
  deckCodeActiveDesktop: { color: colors.coral },
  deckDue: { color: colors.muted, fontSize: 9, fontWeight: "800" },
  deckDueActive: { color: "#AFC0BA" },
  deckDueActiveDesktop: { color: colors.ink2 },
  deckName: { color: colors.ink, fontSize: 14, lineHeight: 18, fontWeight: "800", marginTop: 7 },
  deckNameActive: { color: "#fff" },
  deckNameActiveDesktop: { color: colors.ink },
  pressed: { opacity: 0.66 },
  stage: { flex: 1, minWidth: 0, maxWidth: 800, alignSelf: "center", width: "100%" },
  stageTop: { minHeight: 68, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14 },
  stageIdentity: { flex: 1 },
  unitCode: { color: colors.coral, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 },
  stageTitle: { color: colors.ink, fontSize: 24, lineHeight: 28, fontWeight: "900", letterSpacing: -0.8, marginTop: 3 },
  counterWrap: { alignItems: "flex-end" },
  counter: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  counterLabel: { color: colors.muted, fontSize: 8, fontWeight: "900", letterSpacing: 1.2 },
  syncBar: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 5 },
  syncDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.coral },
  syncDotOffline: { backgroundColor: colors.muted },
  syncText: { color: colors.muted, fontSize: 10, fontWeight: "800" },
  progressTrack: { height: 3, backgroundColor: colors.line, borderRadius: 2, marginBottom: 18, overflow: "hidden" },
  progressFill: { height: 3, backgroundColor: colors.coral },
  cardHit: { minHeight: 410, borderRadius: radii.lg },
  card: { minHeight: 410, borderRadius: radii.lg, overflow: "hidden", ...shadow },
  cardFace: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, padding: 28, justifyContent: "space-between" },
  cardPressed: { opacity: 0.96 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardLabel: { color: colors.lime, fontSize: 9, fontWeight: "900", letterSpacing: 1.4 },
  cardLabelDark: { color: colors.ink2 },
  cardPosition: { color: "#8BA19B", fontSize: 9, fontWeight: "900" },
  cardBody: { flex: 1, justifyContent: "center", paddingVertical: 38 },
  topic: { color: "#9EB2AC", fontSize: 10, lineHeight: 14, fontWeight: "800" },
  topicDark: { color: colors.ink2 },
  cardText: { color: "#fff", fontSize: 29, lineHeight: 37, fontWeight: "800", letterSpacing: -0.7, marginTop: 10 },
  cardTextDark: { color: colors.ink },
  source: { color: colors.ink2, fontSize: 11, lineHeight: 17, fontWeight: "700", marginTop: 22, paddingTop: 14, borderTopWidth: 1, borderTopColor: "rgba(16,45,42,.14)" },
  reveal: { minHeight: 50, marginTop: 10, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  revealText: { color: colors.ink, fontSize: 12, fontWeight: "900" },
  ratingGrid: { flexDirection: "row", gap: 7, marginTop: 10 },
  rateButton: { flex: 1, minHeight: 58, paddingHorizontal: 8, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: "center", justifyContent: "center", gap: 2 },
  rateAgain: { borderColor: "#E8B9AF", backgroundColor: "#FFF5F2" },
  ratePressed: { transform: [{ scale: 0.98 }] },
  rateKey: { color: colors.muted, fontSize: 8, fontWeight: "800" },
  rateName: { color: colors.ink, fontSize: 11, fontWeight: "900" },
  rateAgainText: { color: colors.danger },
  undoBar: { minHeight: 42, marginTop: 8, paddingHorizontal: 12, borderRadius: radii.sm, backgroundColor: colors.cream, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  undoText: { color: colors.ink2, fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  undoAction: { color: colors.ink, fontSize: 11, fontWeight: "900" },
  keyboard: { color: colors.muted, fontSize: 9, fontWeight: "700", textAlign: "center", marginTop: 10 },
  completePanel: { minHeight: 400, paddingVertical: 44, borderTopWidth: 1, borderTopColor: colors.line, justifyContent: "center" },
  completeKicker: { color: colors.coral, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  completeTitle: { color: colors.ink, fontSize: 42, lineHeight: 47, fontWeight: "900", letterSpacing: -2, marginTop: 6 },
  completeMeta: { color: colors.muted, fontSize: 12, lineHeight: 18, fontWeight: "700", marginTop: 12 },
  sessionStats: { flexDirection: "row", alignItems: "center", gap: 28, marginTop: 28, marginBottom: 8 },
  statNumber: { color: colors.ink, fontSize: 30, fontWeight: "900" },
  statLabel: { color: colors.muted, fontSize: 10, fontWeight: "800", marginTop: 2 },
  statDivider: { width: 1, height: 42, backgroundColor: colors.line },
  completeActions: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 28 },
  primary: { alignSelf: "flex-start", minHeight: 46, paddingHorizontal: 17, borderRadius: radii.sm, backgroundColor: colors.ink, flexDirection: "row", alignItems: "center", gap: 22 },
  primaryText: { color: "#fff", fontSize: 12, fontWeight: "900" },
  primaryArrow: { color: colors.lime, fontSize: 16, fontWeight: "900" },
  secondary: { minHeight: 46, paddingHorizontal: 17, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: colors.ink, fontSize: 12, fontWeight: "800" },
});
