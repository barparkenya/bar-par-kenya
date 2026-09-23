import { Link, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const insets = useSafeAreaInsets();
  const desktop = width >= 920;
  const compact = width < 600;

  const [phase, setPhase] = useState<Phase>("loading");
  const [decks, setDecks] = useState<Deck[]>([]);
  const [selectedDeck, setSelectedDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [deckPickerOpen, setDeckPickerOpen] = useState(false);
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

  const revealMotion = useRef(new Animated.Value(0)).current;
  const cardMotion = useRef(new Animated.Value(1)).current;
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
      duration: reduceMotion ? 0 : 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [revealed, reduceMotion, revealMotion]);

  useEffect(() => {
    if (phase !== "ready" || !card) return;
    cardMotion.stopAnimation();
    if (reduceMotion) {
      cardMotion.setValue(1);
      return;
    }
    cardMotion.setValue(0);
    Animated.timing(cardMotion, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [card?.id, phase, reduceMotion, cardMotion]);

  const animatedCardBackground = revealMotion.interpolate({
    inputRange: [0, 0.52, 1],
    outputRange: [colors.ink, colors.ink2, colors.lime],
  });
  const animatedCardScale = revealMotion.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1, 0.988, 1],
  });
  const animatedCardTilt = revealMotion.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ["0deg", "-1deg", "0deg"],
  });
  const frontOpacity = revealMotion.interpolate({
    inputRange: [0, 0.43, 0.51, 1],
    outputRange: [1, 1, 0, 0],
  });
  const frontTranslate = revealMotion.interpolate({
    inputRange: [0, 0.43, 1],
    outputRange: [0, 0, -12],
  });
  const backOpacity = revealMotion.interpolate({
    inputRange: [0, 0.5, 0.59, 1],
    outputRange: [0, 0, 1, 1],
  });
  const backTranslate = revealMotion.interpolate({
    inputRange: [0, 0.58, 1],
    outputRange: [12, 7, 0],
  });
  const cardOpacity = cardMotion.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const cardTranslate = cardMotion.interpolate({
    inputRange: [0, 1],
    outputRange: [10, 0],
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
    setDeckPickerOpen(false);
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

  const deckButton = (deck: Deck, mobile = false) => {
    const active = selectedDeck?.subjectId === deck.subjectId;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        key={deck.subjectId}
        onPress={() => void openDeck(deck)}
        style={({ pressed }) => [
          mobile ? styles.mobileDeckItem : styles.deckButton,
          active && (mobile ? styles.mobileDeckItemActive : styles.deckButtonActive),
          pressed && styles.pressed,
        ]}
      >
        <View style={mobile ? styles.mobileDeckItemTop : styles.deckButtonTop}>
          <Text style={[styles.deckCode, active && styles.deckCodeActive]}>{deck.unitCode}</Text>
          <Text style={[styles.deckDue, active && styles.deckDueActive]}>{deckStatus(deck)}</Text>
        </View>
        {!mobile ? <Text numberOfLines={2} style={[styles.deckName, active && styles.deckNameActive]}>{deck.name}</Text> : null}
      </Pressable>
    );
  };

  return (
    <View style={styles.page}>
      <AppHeader />

      <View
        style={[
          styles.body,
          desktop && styles.bodyDesktop,
          !desktop && { paddingBottom: Math.max(insets.bottom, 10) + 76 },
        ]}
      >
        {desktop ? (
          <View style={styles.deckRailDesktop}>
            <View style={styles.railHead}>
              <Text style={styles.railLabel}>CARDS</Text>
              <Text style={styles.railTotal}>{dueTotal}</Text>
            </View>
            <ScrollView
              style={styles.deckRailScroll}
              contentContainerStyle={styles.deckListDesktop}
              showsVerticalScrollIndicator={false}
            >
              {decks.map((deck) => deckButton(deck))}
            </ScrollView>
          </View>
        ) : (
          <View style={styles.mobileDeckShell}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: deckPickerOpen }}
              onPress={() => setDeckPickerOpen((value) => !value)}
              style={({ pressed }) => [styles.mobileDeckCurrent, pressed && styles.pressed]}
            >
              <View style={styles.mobileDeckIdentity}>
                <Text style={styles.mobileDeckCode}>{selectedDeck?.unitCode ?? "ATP"}</Text>
                <Text numberOfLines={1} style={styles.mobileDeckName}>{selectedDeck?.name ?? "Cards"}</Text>
              </View>
              <View style={styles.mobileDeckRight}>
                <Text style={styles.mobileDeckStatus}>{selectedDeck ? deckStatus(selectedDeck) : ""}</Text>
                <Text style={styles.mobileDeckChevron}>{deckPickerOpen ? "↑" : "↓"}</Text>
              </View>
            </Pressable>

            {deckPickerOpen ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.mobileDeckPicker}
              >
                {decks.map((deck) => deckButton(deck, true))}
              </ScrollView>
            ) : null}
          </View>
        )}

        <View style={styles.stage}>
          <View style={[styles.stageTop, compact && styles.stageTopCompact]}>
            <View style={styles.stageIdentity}>
              {desktop ? <Text style={styles.unitCode}>{selectedDeck?.unitCode ?? "ATP"}</Text> : null}
              <Text numberOfLines={1} style={[styles.stageTitle, compact && styles.stageTitleCompact]}>
                {selectedDeck?.name ?? "Cards"}
              </Text>
            </View>

            <View style={styles.stageRight}>
              {offline || (pending > 0 && !lastQueued) ? (
                <View style={styles.syncInline}>
                  <View style={[styles.syncDot, offline && styles.syncDotOffline]} />
                  <Text style={styles.syncText}>{offline ? "Offline" : `${pending} pending`}</Text>
                </View>
              ) : null}

              {phase === "ready" ? (
                <View style={styles.counterWrap}>
                  <Text style={styles.counter}>{remaining}</Text>
                  <Text style={styles.counterLabel}>LEFT</Text>
                </View>
              ) : null}
            </View>
          </View>

          {phase === "ready" ? (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: (String(progress) + "%") as any }]} />
            </View>
          ) : null}

          {phase === "ready" && card ? (
            <View style={styles.studyWorkspace}>
              <Animated.View
                style={[
                  styles.cardShell,
                  {
                    opacity: cardOpacity,
                    transform: [{ translateY: cardTranslate }],
                  },
                ]}
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
                    pointerEvents={revealed ? "none" : "auto"}
                    style={[
                      styles.cardFace,
                      {
                        opacity: frontOpacity,
                        transform: [{ translateY: frontTranslate }],
                      },
                    ]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Reveal answer"
                      onPress={() => setRevealed(true)}
                      style={({ pressed }) => [styles.frontPress, pressed && styles.cardPressed]}
                    >
                      <View style={styles.cardHeader}>
                        <Text style={styles.cardLabel}>RECALL</Text>
                        <Text style={styles.cardPosition}>
                          {String(index + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}
                        </Text>
                      </View>
                      <View style={styles.cardContent}>
                        <Text style={styles.topic}>{card.topicName}</Text>
                        <Text style={[styles.cardText, compact && styles.cardTextCompact]}>{card.front}</Text>
                      </View>
                    </Pressable>
                  </Animated.View>

                  <Animated.View
                    pointerEvents={revealed ? "auto" : "none"}
                    style={[
                      styles.cardFace,
                      {
                        opacity: backOpacity,
                        transform: [{ translateY: backTranslate }],
                      },
                    ]}
                  >
                    <View style={styles.answerFace}>
                      <View style={styles.cardHeader}>
                        <Text style={[styles.cardLabel, styles.cardLabelDark]}>ANSWER</Text>
                        <Text style={[styles.cardPosition, styles.cardLabelDark]}>
                          {String(index + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}
                        </Text>
                      </View>
                      <ScrollView
                        style={styles.answerScroll}
                        contentContainerStyle={styles.answerContent}
                        showsVerticalScrollIndicator={false}
                        nestedScrollEnabled
                      >
                        <Text style={[styles.topic, styles.topicDark]}>{card.topicName}</Text>
                        <Text style={[styles.cardText, styles.cardTextDark, compact && styles.cardTextCompact]}>{card.back}</Text>
                        {card.source ? <Text style={styles.source}>{card.source}</Text> : null}
                      </ScrollView>
                    </View>
                  </Animated.View>
                </Animated.View>
              </Animated.View>

              <View style={styles.controls}>
                {!revealed ? (
                  <Pressable
                    onPress={() => setRevealed(true)}
                    style={({ pressed }) => [styles.reveal, pressed && styles.controlPressed]}
                  >
                    <Text style={styles.revealText}>Reveal answer</Text>
                  </Pressable>
                ) : (
                  <View style={styles.ratingGrid}>
                    {(["again", "hard", "good", "easy"] as const).map((rating, ratingIndex) => (
                      <Pressable
                        key={rating}
                        onPress={() => void rate(rating)}
                        style={({ pressed }) => [
                          styles.rateButton,
                          rating === "again" && styles.rateAgain,
                          pressed && styles.controlPressed,
                        ]}
                      >
                        {Platform.OS === "web" ? (
                          <Text style={[styles.rateKey, rating === "again" && styles.rateAgainText]}>
                            {ratingIndex + 1}
                          </Text>
                        ) : null}
                        <Text style={[styles.rateName, rating === "again" && styles.rateAgainText]}>
                          {rating[0].toUpperCase() + rating.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.feedbackSlot}>
                {lastQueued ? (
                  <View style={styles.undoInline}>
                    <Text style={styles.undoText}>Saved as {lastQueued.rating}</Text>
                    <Pressable hitSlop={8} onPress={() => void undoLast()}>
                      <Text style={styles.undoAction}>Undo</Text>
                    </Pressable>
                  </View>
                ) : Platform.OS === "web" ? (
                  <Text style={styles.keyboard}>Space · 1 · 2 · 3 · 4</Text>
                ) : null}
              </View>
            </View>
          ) : (
            <ScrollView
              style={styles.stateScroll}
              contentContainerStyle={styles.stateScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {phase === "loading" ? (
                <StatePanel title="Loading…" />
              ) : phase === "error" ? (
                <StatePanel
                  title="Could not load this deck."
                  action="Try again"
                  onPress={() => selectedDeck ? void openDeck(selectedDeck) : void loadDecks()}
                />
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
                    <View style={styles.undoInline}>
                      <Text style={styles.undoText}>Saved as {lastQueued.rating}</Text>
                      <Pressable hitSlop={8} onPress={() => void undoLast()}>
                        <Text style={styles.undoAction}>Undo</Text>
                      </Pressable>
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
              ) : null}
            </ScrollView>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  body: {
    flex: 1,
    width: "100%",
    maxWidth: 1440,
    alignSelf: "center",
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
    minHeight: 0,
  },
  bodyDesktop: {
    flexDirection: "row",
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 20,
    gap: 24,
  },

  pressed: { opacity: 0.66 },
  controlPressed: { transform: [{ scale: 0.985 }], opacity: 0.82 },

  deckRailDesktop: {
    width: 244,
    flexShrink: 0,
    minHeight: 0,
    paddingRight: 18,
    borderRightWidth: 1,
    borderRightColor: colors.line,
  },
  deckRailScroll: { flex: 1, minHeight: 0 },
  deckListDesktop: { paddingBottom: 18 },
  railHead: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 5,
    marginBottom: 2,
  },
  railLabel: { color: colors.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  railTotal: { color: colors.ink, fontSize: 11, fontWeight: "900" },
  deckButton: {
    paddingHorizontal: 10,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
    backgroundColor: "transparent",
  },
  deckButtonActive: { borderLeftColor: colors.coral, paddingLeft: 14 },
  deckButtonTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  deckCode: { color: colors.coral, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  deckCodeActive: { color: colors.ink },
  deckDue: { color: colors.muted, fontSize: 9, fontWeight: "800" },
  deckDueActive: { color: colors.ink2 },
  deckName: { color: colors.ink2, fontSize: 13, lineHeight: 17, fontWeight: "700", marginTop: 5 },
  deckNameActive: { color: colors.ink, fontWeight: "900" },

  mobileDeckShell: { flexShrink: 0, borderBottomWidth: 1, borderBottomColor: colors.line },
  mobileDeckCurrent: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 3,
  },
  mobileDeckIdentity: { minWidth: 0, flex: 1, flexDirection: "row", alignItems: "center", gap: 9 },
  mobileDeckCode: { color: colors.coral, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  mobileDeckName: { minWidth: 0, flex: 1, color: colors.ink, fontSize: 13, fontWeight: "800" },
  mobileDeckRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  mobileDeckStatus: { color: colors.muted, fontSize: 9, fontWeight: "800" },
  mobileDeckChevron: { color: colors.ink, fontSize: 13, fontWeight: "900" },
  mobileDeckPicker: { gap: 4, paddingBottom: 8, paddingRight: 8 },
  mobileDeckItem: {
    minWidth: 78,
    minHeight: 42,
    paddingHorizontal: 9,
    paddingVertical: 8,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    justifyContent: "center",
  },
  mobileDeckItemActive: { borderBottomColor: colors.coral },
  mobileDeckItemTop: { gap: 2 },

  stage: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
  },
  stageTop: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
  },
  stageTopCompact: { minHeight: 44 },
  stageIdentity: { flex: 1, minWidth: 0 },
  unitCode: { color: colors.coral, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 },
  stageTitle: { color: colors.ink, fontSize: 22, lineHeight: 27, fontWeight: "900", letterSpacing: -0.7, marginTop: 2 },
  stageTitleCompact: { fontSize: 18, lineHeight: 22, marginTop: 0 },
  stageRight: { flexDirection: "row", alignItems: "center", gap: 14 },
  counterWrap: { alignItems: "flex-end" },
  counter: { color: colors.ink, fontSize: 18, lineHeight: 20, fontWeight: "900" },
  counterLabel: { color: colors.muted, fontSize: 7, fontWeight: "900", letterSpacing: 1.1 },
  syncInline: { flexDirection: "row", alignItems: "center", gap: 5 },
  syncDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.coral },
  syncDotOffline: { backgroundColor: colors.muted },
  syncText: { color: colors.muted, fontSize: 9, fontWeight: "800" },
  progressTrack: {
    height: 3,
    backgroundColor: colors.line,
    borderRadius: 2,
    marginBottom: 9,
    overflow: "hidden",
  },
  progressFill: { height: 3, backgroundColor: colors.coral },

  studyWorkspace: { flex: 1, minHeight: 0 },
  cardShell: { flex: 1, minHeight: 0, borderRadius: radii.lg },
  card: { flex: 1, minHeight: 0, borderRadius: radii.lg, overflow: "hidden", ...shadow },
  cardFace: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  frontPress: { flex: 1, padding: 24 },
  answerFace: { flex: 1, paddingTop: 24, paddingHorizontal: 24 },
  cardPressed: { opacity: 0.96 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardLabel: { color: colors.lime, fontSize: 9, fontWeight: "900", letterSpacing: 1.4 },
  cardLabelDark: { color: colors.ink2 },
  cardPosition: { color: "#8BA19B", fontSize: 9, fontWeight: "900" },
  cardContent: { flex: 1, justifyContent: "center", paddingVertical: 24 },
  answerScroll: { flex: 1, minHeight: 0, marginTop: 4 },
  answerContent: { flexGrow: 1, justifyContent: "center", paddingVertical: 24, paddingBottom: 30 },
  topic: { color: "#9EB2AC", fontSize: 10, lineHeight: 14, fontWeight: "800" },
  topicDark: { color: colors.ink2 },
  cardText: {
    color: "#fff",
    fontSize: 28,
    lineHeight: 36,
    fontWeight: "800",
    letterSpacing: -0.65,
    marginTop: 10,
  },
  cardTextCompact: { fontSize: 24, lineHeight: 31, letterSpacing: -0.45 },
  cardTextDark: { color: colors.ink },
  source: {
    color: colors.ink2,
    fontSize: 11,
    lineHeight: 17,
    fontWeight: "700",
    marginTop: 20,
    paddingTop: 13,
    borderTopWidth: 1,
    borderTopColor: "rgba(16,45,42,.14)",
  },

  controls: { flexShrink: 0, minHeight: 58, justifyContent: "center", marginTop: 8 },
  reveal: {
    minHeight: 54,
    borderRadius: radii.sm,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  revealText: { color: "#fff", fontSize: 12, fontWeight: "900" },
  ratingGrid: { flexDirection: "row", gap: 6 },
  rateButton: {
    flex: 1,
    minHeight: 54,
    paddingHorizontal: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  },
  rateAgain: { borderColor: "#E8B9AF", backgroundColor: "#FFF5F2" },
  rateKey: { color: colors.muted, fontSize: 8, fontWeight: "800" },
  rateName: { color: colors.ink, fontSize: 11, fontWeight: "900" },
  rateAgainText: { color: colors.danger },

  feedbackSlot: {
    minHeight: 30,
    flexShrink: 0,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  undoInline: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  undoText: { color: colors.muted, fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  undoAction: { color: colors.ink, fontSize: 10, fontWeight: "900", textDecorationLine: "underline" },
  keyboard: { color: colors.muted, fontSize: 9, fontWeight: "700", textAlign: "center" },

  stateScroll: { flex: 1, minHeight: 0 },
  stateScrollContent: { flexGrow: 1, justifyContent: "center", paddingVertical: 24 },
  completePanel: { minHeight: 320, paddingVertical: 30, borderTopWidth: 1, borderTopColor: colors.line, justifyContent: "center" },
  completeKicker: { color: colors.coral, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  completeTitle: { color: colors.ink, fontSize: 40, lineHeight: 45, fontWeight: "900", letterSpacing: -1.8, marginTop: 6 },
  completeMeta: { color: colors.muted, fontSize: 12, lineHeight: 18, fontWeight: "700", marginTop: 12 },
  sessionStats: { flexDirection: "row", alignItems: "center", gap: 28, marginTop: 26, marginBottom: 8 },
  statNumber: { color: colors.ink, fontSize: 30, fontWeight: "900" },
  statLabel: { color: colors.muted, fontSize: 10, fontWeight: "800", marginTop: 2 },
  statDivider: { width: 1, height: 42, backgroundColor: colors.line },
  completeActions: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 26 },
  primary: {
    alignSelf: "flex-start",
    minHeight: 46,
    paddingHorizontal: 17,
    borderRadius: radii.sm,
    backgroundColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    gap: 22,
  },
  primaryText: { color: "#fff", fontSize: 12, fontWeight: "900" },
  primaryArrow: { color: colors.lime, fontSize: 16, fontWeight: "900" },
  secondary: {
    minHeight: 46,
    paddingHorizontal: 17,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { color: colors.ink, fontSize: 12, fontWeight: "800" },
});
