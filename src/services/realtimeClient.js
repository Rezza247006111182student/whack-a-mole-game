import { createClient } from "@supabase/supabase-js";

const DEFAULT_LOBBY_CHANNEL = "lobby";
const MAX_ROOM_PLAYERS = 6;
const GAME_DURATION_MS = 60_000;
const MAX_BONUS_TIME_MS = 60_000;
const GAME_END_GRACE_MS = 5_000;
const SCORE_PRESENCE_SYNC_MS = 900;
const BROADCAST_HTTP_TIMEOUT_MS = 1200;
const MIN_SCORE_DELTA = -20;
const MAX_SCORE_DELTA = 60;

export function createRealtimeClient(options) {
  const mode = options?.mode || "websocket";
  if (mode === "supabase") {
    return createSupabaseRealtimeClient(options);
  }

  return createWebSocketClient(options);
}

function createWebSocketClient({
  getUrl,
  onDisabled,
  onOpen,
  onClose,
  onMessage,
}) {
  let socket = null;
  let reconnectTimer = null;
  let pendingMessages = [];
  let intentionalDisconnect = false;

  function connect() {
    if (
      socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    const wsUrl = getUrl();

    if (!wsUrl) {
      onDisabled?.();
      return;
    }

    intentionalDisconnect = false;
    socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      flushPendingMessages();
      onOpen?.();
    });

    socket.addEventListener("close", () => {
      const intentional = intentionalDisconnect;
      socket = null;
      onClose?.({ intentional });

      if (!intentional) {
        reconnectTimer = setTimeout(connect, 1200);
      }
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      onMessage?.(message);
    });
  }

  function send(type, payload = {}) {
    const message = JSON.stringify({ type, payload });

    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(message);
      return true;
    }

    if (socket?.readyState === WebSocket.CONNECTING) {
      pendingMessages.push(message);
    }

    return false;
  }

  function flushPendingMessages() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    for (const message of pendingMessages) {
      socket.send(message);
    }
    pendingMessages = [];
  }

  function isConnected() {
    return socket?.readyState === WebSocket.OPEN;
  }

  function isConnecting() {
    return socket?.readyState === WebSocket.CONNECTING;
  }

  function disconnect() {
    intentionalDisconnect = true;
    pendingMessages = [];
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.close();
      socket = null;
    }
  }

  function getStatus() {
    if (isConnected()) return "connected";
    if (isConnecting()) return "connecting";
    return "idle";
  }

  function clearPendingMessages() {
    pendingMessages = [];
  }

  function sendNow(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type, payload }));
    return true;
  }

  return {
    connect,
    disconnect,
    send,
    sendNow,
    getStatus,
    clearPendingMessages,
  };
}

function createSupabaseRealtimeClient({
  supabaseConfig,
  playerId,
  getProfile,
  onDisabled,
  onOpen,
  onClose,
  onMessage,
}) {
  const supabaseUrl = supabaseConfig?.url || "";
  const supabaseAnonKey = supabaseConfig?.anonKey || "";
  const lobbyChannelName =
    supabaseConfig?.lobbyChannel || DEFAULT_LOBBY_CHANNEL;

  let supabase = null;
  let lobbyChannel = null;
  let roomChannel = null;
  let currentRoomCode = null;
  let lobbySubscribed = false;
  let roomSubscribed = false;
  let connected = false;
  let roomStatus = "waiting";
  let roomEndsAt = null;
  let roomTimer = null;
  let stateAnnounceTimer = null;
  let finishAnnounceTimer = null;
  let scorePresenceTimer = null;
  let lastScorePresenceSyncAt = 0;
  let joinValidationTimer = null;
  let joinedAt = Date.now();
  let presenceRevision = 0;
  let scoreCache = new Map();
  let finishedCache = new Map();
  let pendingLobbyBroadcasts = [];
  let pendingRoomBroadcasts = [];
  let playerState = {
    ready: false,
    score: 0,
    effect: "Menunggu",
    scoreUpdatedAt: Date.now(),
    scoreRevision: 0,
    finished: false,
    finishedAt: null,
  };

  function connect() {
    if (!supabaseUrl || !supabaseAnonKey) {
      onDisabled?.();
      return;
    }

    if (lobbyChannel) return;

    supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: "sb-realtime-presence",
      },
    });

    lobbyChannel = supabase.channel(lobbyChannelName, {
      config: { presence: { key: playerId } },
    });

    lobbyChannel
      .on("presence", { event: "sync" }, handleLobbySync)
      .on("broadcast", { event: "presence:refresh" }, handleLobbySync)
      .subscribe((status) => {
        lobbySubscribed = status === "SUBSCRIBED";
        if (!lobbySubscribed) return;
        connected = true;
        trackLobbyPresence();
        flushLobbyBroadcasts();
        onOpen?.();
        onMessage?.({ type: "connected", payload: { playerId } });
        handleLobbySync();
      });
  }

  function disconnect() {
    clearRoomTimer();
    clearStateAnnounce();
    clearFinishAnnounce();
    clearScorePresenceSync();
    clearJoinValidation();
    lobbySubscribed = false;
    roomSubscribed = false;
    pendingLobbyBroadcasts = [];
    pendingRoomBroadcasts = [];
    scoreCache.clear();
    finishedCache.clear();
    if (roomChannel) {
      roomChannel.unsubscribe();
      roomChannel = null;
    }
    if (lobbyChannel) {
      lobbyChannel.unsubscribe();
      lobbyChannel = null;
    }
    if (supabase) {
      supabase.removeAllChannels();
      supabase = null;
    }
    connected = false;
    onClose?.({ intentional: true });
  }

  function getStatus() {
    return connected ? "connected" : "idle";
  }

  function clearPendingMessages() {
    return;
  }

  function sendNow(type, payload = {}) {
    return send(type, payload);
  }

  function send(type, payload = {}) {
    switch (type) {
      case "profile:update":
        applyProfileUpdate(payload);
        return true;
      case "rooms:list":
        handleLobbySync();
        return true;
      case "room:create":
        createRoom();
        return true;
      case "room:join":
        joinRoom(String(payload.code || "").toUpperCase());
        return true;
      case "room:leave":
      case "game:exit":
        leaveRoom();
        return true;
      case "room:ready":
        setReady(Boolean(payload.ready));
        return true;
      case "game:start":
        startGame();
        return true;
      case "game:score":
        addScore(payload.points, payload.effect || "Normal");
        return true;
      case "game:finished":
        finishPlayerGame();
        return true;
      default:
        return false;
    }
  }

  function applyProfileUpdate(payload) {
    const profile = getProfile?.() || {};
    const username = String(
      payload.username || profile.username || "Player",
    ).slice(0, 20);
    const avatar = String(payload.avatar || profile.avatar || "").slice(0, 400);
    const bio = String(payload.bio || profile.bio || "").slice(0, 120);
    const guest = Boolean(payload.guest ?? profile.guest);

    trackLobbyPresence({ username, avatar, bio, guest });
    if (roomChannel) {
      trackRoomPresence({ username, avatar, bio, guest });
    }
  }

  function createRoom() {
    const code = createRoomCode();
    scoreCache.clear();
    finishedCache.clear();
    playerState = {
      ready: true,
      score: 0,
      effect: "Menunggu",
      scoreUpdatedAt: Date.now(),
      scoreRevision: 0,
      finished: false,
      finishedAt: null,
    };
    joinRoom(code, { host: true });
  }

  function joinRoom(code, options = {}) {
    if (!code) return;

    const rooms = buildRoomSummaries(getLobbyPresence());
    const existingRoom = rooms.find((room) => room.code === code);
    const joiningAsGuest = !options.host;
    const shouldValidateMissing = joiningAsGuest && !existingRoom;

    if (existingRoom && existingRoom.status !== "waiting") {
      onMessage?.({
        type: "error",
        payload: { message: "Room sedang bermain. Coba room lain." },
      });
      return;
    }

    if (existingRoom && existingRoom.players >= MAX_ROOM_PLAYERS) {
      onMessage?.({ type: "error", payload: { message: "Room sudah penuh." } });
      return;
    }

    if (currentRoomCode !== code) {
      scoreCache.clear();
      finishedCache.clear();
    }

    currentRoomCode = code;
    roomStatus = "waiting";
    roomEndsAt = null;
    clearRoomTimer();
    clearScorePresenceSync();
    clearJoinValidation();
    trackLobbyPresence({
      roomCode: code,
      roomStatus: "waiting",
      roomEndsAt: null,
    });

    if (roomChannel) {
      roomChannel.unsubscribe();
      roomChannel = null;
    }
    roomSubscribed = false;
    pendingRoomBroadcasts = [];

    roomChannel = supabase.channel(`room:${code}`, {
      config: {
        presence: { key: playerId },
        broadcast: { self: true },
      },
    });

    roomChannel
      .on("presence", { event: "sync" }, handleRoomSync)
      .on("broadcast", { event: "presence:refresh" }, handleRoomSync)
      .on("broadcast", { event: "game:score" }, handleRoomScoreBroadcast)
      .on("broadcast", { event: "game:state" }, handleRoomStateBroadcast)
      .on("broadcast", { event: "game:finished" }, handleRoomFinishedBroadcast)
      .on("broadcast", { event: "game:started" }, (event) => {
        const now = Date.now();
        const endsAt =
          Number(event.payload?.endsAt || 0) || now + GAME_DURATION_MS;
        const alreadyPlaying = roomStatus === "playing";
        roomStatus = "playing";
        roomEndsAt = Math.max(Number(roomEndsAt || 0), endsAt);
        clearFinishAnnounce();

        if (!alreadyPlaying) {
          scoreCache.clear();
          finishedCache.clear();
          playerState.score = 0;
          playerState.effect = "Normal";
          playerState.scoreUpdatedAt = now;
          playerState.scoreRevision = 0;
          playerState.finished = false;
          playerState.finishedAt = null;
          rememberScore(
            playerId,
            playerState.score,
            playerState.effect,
            now,
            playerState.scoreRevision,
          );
        }

        trackRoomPresence({ roomStatus, roomEndsAt });
        syncLobbyRoomStatus();
        startStateAnnounce();
        announcePlayerState("started");
        handleRoomSync();
      })
      .on("broadcast", { event: "game:ended" }, handleRoomEndedBroadcast)
      .subscribe((status) => {
        roomSubscribed = status === "SUBSCRIBED";
        if (!roomSubscribed) return;
        trackRoomPresence();
        syncLobbyRoomStatus();
        flushRoomBroadcasts();
        handleRoomSync();

        if (shouldValidateMissing && !joinValidationTimer) {
          joinValidationTimer = setTimeout(() => {
            joinValidationTimer = null;
            const room = buildRoomFromPresence(getRoomPresence());
            if (!room) return;
            const onlyMe =
              room.players.length === 1 && room.players[0].id === playerId;
            if (onlyMe) {
              leaveRoom();
              onMessage?.({
                type: "error",
                payload: { message: "Room tidak ditemukan." },
              });
            }
          }, 1200);
        }
      });
  }

  function leaveRoom() {
    clearRoomTimer();
    clearStateAnnounce();
    clearFinishAnnounce();
    clearScorePresenceSync();
    clearJoinValidation();
    if (roomChannel) {
      roomChannel.unsubscribe();
      roomChannel = null;
    }
    roomSubscribed = false;
    pendingRoomBroadcasts = [];

    currentRoomCode = null;
    roomStatus = "waiting";
    roomEndsAt = null;
    scoreCache.clear();
    finishedCache.clear();
    playerState.ready = false;
    playerState.score = 0;
    playerState.effect = "Menunggu";
    playerState.scoreUpdatedAt = Date.now();
    playerState.scoreRevision = 0;
    playerState.finished = false;
    playerState.finishedAt = null;

    trackLobbyPresence({ roomCode: "", roomStatus: "" });
    onMessage?.({ type: "room:update", payload: { room: null } });
    handleLobbySync();
  }

  function setReady(ready) {
    playerState.ready = ready;
    trackRoomPresence();
  }

  function startGame() {
    if (!roomChannel || !currentRoomCode) return;

    const room = buildRoomFromPresence(getRoomPresence());
    if (!room) return;

    const isHost = room.hostId === playerId;
    const everyoneReady =
      room.players.length > 0 && room.players.every((player) => player.ready);

    if (!isHost) return;
    if (!everyoneReady) {
      onMessage?.({
        type: "error",
        payload: { message: "Semua pemain harus ready dulu." },
      });
      return;
    }

    const now = Date.now();
    roomStatus = "playing";
    roomEndsAt = now + GAME_DURATION_MS;
    clearFinishAnnounce();
    scoreCache.clear();
    finishedCache.clear();
    playerState.score = 0;
    playerState.effect = "Normal";
    playerState.scoreUpdatedAt = now;
    playerState.scoreRevision = 0;
    playerState.finished = false;
    playerState.finishedAt = null;
    rememberScore(
      playerId,
      playerState.score,
      playerState.effect,
      now,
      playerState.scoreRevision,
    );
    trackRoomPresence({
      roomStatus,
      roomEndsAt,
      score: playerState.score,
      effect: playerState.effect,
      scoreUpdatedAt: now,
      scoreRevision: playerState.scoreRevision,
      finished: false,
      finishedAt: null,
    });
    syncLobbyRoomStatus();

    sendRoomBroadcast(
      "game:started",
      { endsAt: roomEndsAt },
      { queue: false, httpFallback: true },
    );

    ensureRoomTimer();
    startStateAnnounce();
    announcePlayerState("started");
    handleRoomSync();
  }

  function addScore(points, effect) {
    if (!roomChannel || !currentRoomCode) return;
    if (roomStatus !== "playing") return;
    if (playerState.finished) return;

    const boundedPoints = normalizeScoreDelta(points);
    const now = Date.now();
    playerState.score = Math.max(0, (playerState.score || 0) + boundedPoints);
    playerState.effect = String(effect || "Normal").slice(0, 24);
    playerState.scoreUpdatedAt = now;
    playerState.scoreRevision += 1;
    rememberScore(
      playerId,
      playerState.score,
      playerState.effect,
      now,
      playerState.scoreRevision,
    );
    scheduleScorePresenceSync();
    sendRoomBroadcast(
      "game:score",
      {
        playerId,
        points: boundedPoints,
        score: playerState.score,
        effect: playerState.effect,
        scoreUpdatedAt: now,
        scoreRevision: playerState.scoreRevision,
      },
      { queue: false, httpFallback: true },
    );
    announcePlayerState("score");
    emitOptimisticRoomUpdate();
  }

  function finishPlayerGame() {
    if (!roomChannel || !currentRoomCode) return;
    if (roomStatus !== "playing") return;
    if (playerState.finished) return;

    const now = Date.now();
    playerState.finished = true;
    playerState.finishedAt = now;
    playerState.effect = "Menunggu hasil";
    clearScorePresenceSync();
    rememberFinished(playerId, now, now);
    rememberScore(
      playerId,
      playerState.score,
      playerState.effect,
      now,
      playerState.scoreRevision,
    );
    trackRoomPresence({
      finished: true,
      finishedAt: now,
      effect: playerState.effect,
      score: playerState.score,
      scoreUpdatedAt: playerState.scoreUpdatedAt,
      scoreRevision: playerState.scoreRevision,
    });
    announcePlayerFinished();
    announcePlayerState("finished");
    startFinishAnnounce();

    const room = buildRoomFromPresence(getRoomPresence());
    if (room) {
      emitRoomUpdate(room);
      endGameIfEveryoneFinished(room);
    }
  }

  function handleLobbySync() {
    if (!lobbyChannel) return;
    const rooms = buildRoomSummaries(getLobbyPresence());
    onMessage?.({ type: "rooms:list", payload: { rooms } });
  }

  function handleRoomSync() {
    if (!roomChannel) return;
    const room = buildRoomFromPresence(getRoomPresence());
    if (!room) return;

    if (joinValidationTimer && room.players.length > 1) {
      clearJoinValidation();
    }

    if (room.status === "playing") {
      ensureRoomTimer();
      endGameIfEveryoneFinished(room);
      onMessage?.({ type: "game:started", payload: { room } });
    }

    if (room.status === "ended") {
      const leaderboard = getLeaderboard(room.players);
      onMessage?.({ type: "game:ended", payload: { leaderboard } });
    }

    onMessage?.({ type: "room:update", payload: { room } });
  }

  function emitRoomUpdate(room) {
    room.players = room.players.map((player) => mergeCachedScore(player));
    room.leaderboard = getLeaderboard(room.players);
    onMessage?.({ type: "room:update", payload: { room } });
  }

  function endGameIfEveryoneFinished(room) {
    const mergedRoom = {
      ...room,
      players: room.players.map((player) => mergeCachedScore(player)),
    };
    if (mergedRoom.status !== "playing") return;
    if (!mergedRoom.players.length) return;
    if (!mergedRoom.players.every((player) => player.finished)) return;

    endGame({ room: mergedRoom });
  }

  function emitOptimisticRoomUpdate() {
    if (!roomChannel || !currentRoomCode) return;

    const room = buildRoomFromPresence(getRoomPresence());
    if (!room) return;

    room.players = room.players.map((player) => {
      const merged = mergeCachedScore(player);
      if (merged.id !== playerId) return merged;

      return {
        ...merged,
        ready: playerState.ready,
        score: playerState.score,
        effect: playerState.effect,
        finished: playerState.finished,
        finishedAt: playerState.finishedAt,
      };
    });
    room.leaderboard = getLeaderboard(room.players);

    onMessage?.({ type: "room:update", payload: { room } });
  }

  function handleRoomScoreBroadcast(event) {
    if (!roomChannel || !currentRoomCode) return;

    const targetPlayerId = String(event.payload?.playerId || "");
    if (!targetPlayerId) return;

    const broadcastScore = Number(event.payload?.score ?? NaN);
    const broadcastEffect = String(event.payload?.effect || "Normal").slice(
      0,
      24,
    );
    const payloadScoreUpdatedAt = Number(event.payload?.scoreUpdatedAt);
    const scoreUpdatedAt = Number.isFinite(payloadScoreUpdatedAt)
      ? payloadScoreUpdatedAt
      : Date.now();
    const scoreRevision = Number(event.payload?.scoreRevision || 0);

    if (Number.isFinite(broadcastScore)) {
      rememberScore(
        targetPlayerId,
        Math.max(0, Math.round(broadcastScore)),
        broadcastEffect,
        scoreUpdatedAt,
        scoreRevision,
      );
    }

    const room = buildRoomFromPresence(getRoomPresence());
    if (!room) return;

    room.players = room.players.map((player) => mergeCachedScore(player));
    room.leaderboard = getLeaderboard(room.players);

    onMessage?.({ type: "room:update", payload: { room } });
  }

  function handleRoomStateBroadcast(event) {
    if (!roomChannel || !currentRoomCode) return;

    applyPlayerSnapshots(event.payload);

    const room = buildRoomFromPresence(getRoomPresence());
    if (!room) return;

    emitRoomUpdate(room);
    endGameIfEveryoneFinished(room);
  }

  function handleRoomFinishedBroadcast(event) {
    if (!roomChannel || !currentRoomCode) return;

    const targetPlayerId = String(event.payload?.playerId || "");
    if (!targetPlayerId) return;

    const payloadFinishedAt = Number(event.payload?.finishedAt);
    const finishedAt = Number.isFinite(payloadFinishedAt)
      ? payloadFinishedAt
      : Date.now();
    const broadcastScore = Number(event.payload?.score ?? NaN);
    const broadcastEffect = String(
      event.payload?.effect || "Menunggu hasil",
    ).slice(0, 24);
    const scoreRevision = Number(
      event.payload?.scoreRevision || event.payload?.player?.scoreRevision || 0,
    );

    rememberFinished(targetPlayerId, finishedAt, finishedAt);
    applyPlayerSnapshots(event.payload);
    if (Number.isFinite(broadcastScore)) {
      rememberScore(
        targetPlayerId,
        Math.max(0, Math.round(broadcastScore)),
        broadcastEffect,
        finishedAt,
        scoreRevision,
      );
    }

    const room = buildRoomFromPresence(getRoomPresence());
    if (!room) return;

    emitRoomUpdate(room);
    endGameIfEveryoneFinished(room);
  }

  function handleRoomEndedBroadcast(event) {
    if (!roomChannel || !currentRoomCode) return;
    if (roomStatus === "ended") return;

    const payloadEndsAt = Number(event.payload?.endsAt);
    const endedAt = Number.isFinite(payloadEndsAt) ? payloadEndsAt : Date.now();
    const room = buildRoomFromPresence(getRoomPresence());
    const players = (room?.players || []).map((player) => ({
      ...mergeCachedScore(player),
      finished: true,
      finishedAt: player.finishedAt || endedAt,
      effect: "Selesai",
    }));
    const leaderboard = Array.isArray(event.payload?.leaderboard) && event.payload.leaderboard.length
      ? event.payload.leaderboard
      : getLeaderboard(players);

    completeRoomGame({ room, players, leaderboard, endedAt, broadcast: false });
  }

  function rememberScore(
    playerIdValue,
    score,
    effect,
    updatedAt = Date.now(),
    revision = 0,
  ) {
    const normalizedScore = normalizeScoreValue(score);
    const parsedUpdatedAt = Number(updatedAt);
    const normalizedUpdatedAt = Number.isFinite(parsedUpdatedAt)
      ? parsedUpdatedAt
      : Date.now();
    const parsedRevision = Number(revision);
    const normalizedRevision = Number.isFinite(parsedRevision)
      ? Math.max(0, Math.round(parsedRevision))
      : 0;
    const previous = scoreCache.get(playerIdValue);

    if (!shouldAcceptScore(previous, normalizedRevision, normalizedUpdatedAt)) {
      return;
    }

    scoreCache.set(playerIdValue, {
      score: normalizedScore,
      effect: String(effect || "Normal").slice(0, 24),
      updatedAt: normalizedUpdatedAt,
      revision: normalizedRevision,
    });
  }

  function shouldAcceptScore(previous, incomingRevision, incomingUpdatedAt) {
    if (!previous) return true;

    const previousRevision = Number(previous.revision || 0);
    if (previousRevision || incomingRevision) {
      if (incomingRevision < previousRevision) return false;
      if (
        incomingRevision === previousRevision &&
        previous.updatedAt > incomingUpdatedAt
      ) {
        return false;
      }
      return true;
    }

    return previous.updatedAt <= incomingUpdatedAt;
  }

  function rememberFinished(playerIdValue, finishedAt, updatedAt = Date.now()) {
    const parsedFinishedAt = Number(finishedAt);
    const normalizedFinishedAt = Number.isFinite(parsedFinishedAt)
      ? parsedFinishedAt
      : Date.now();
    const parsedUpdatedAt = Number(updatedAt);
    const normalizedUpdatedAt = Number.isFinite(parsedUpdatedAt)
      ? parsedUpdatedAt
      : normalizedFinishedAt;
    const previous = finishedCache.get(playerIdValue);

    if (previous && previous.updatedAt > normalizedUpdatedAt) return;

    finishedCache.set(playerIdValue, {
      finished: true,
      finishedAt: normalizedFinishedAt,
      updatedAt: normalizedUpdatedAt,
    });
  }

  function mergeCachedScore(player) {
    const score = normalizeScoreValue(player.score);
    const presenceUpdatedAt =
      Number(player.scoreUpdatedAt || player.updatedAt || 0) || 0;
    const presenceRevision = Number(player.scoreRevision || 0);
    const cached = scoreCache.get(player.id);
    let merged = { ...player, score };

    if (shouldAcceptScore(cached, presenceRevision, presenceUpdatedAt)) {
      rememberScore(
        player.id,
        score,
        player.effect,
        presenceUpdatedAt,
        presenceRevision,
      );
    } else {
      merged = {
        ...merged,
        score: cached.score,
        effect: cached.effect || player.effect,
        scoreRevision: cached.revision || player.scoreRevision || 0,
      };
    }

    const finishedPresenceUpdatedAt =
      Number(player.finishedAt || player.updatedAt || 0) || 0;
    const cachedFinished = finishedCache.get(player.id);

    if (player.finished && (!cachedFinished || finishedPresenceUpdatedAt >= cachedFinished.updatedAt)) {
      rememberFinished(player.id, player.finishedAt, finishedPresenceUpdatedAt);
      return {
        ...merged,
        finished: true,
        finishedAt: player.finishedAt,
      };
    }

    if (cachedFinished) {
      return {
        ...merged,
        finished: true,
        finishedAt: cachedFinished.finishedAt,
        effect: merged.effect === "Normal" ? "Menunggu hasil" : merged.effect,
      };
    }

    return merged;
  }

  function getLobbyPresence() {
    return flattenPresenceState(lobbyChannel?.presenceState?.() || {});
  }

  function getRoomPresence() {
    return flattenPresenceState(roomChannel?.presenceState?.() || {});
  }

  function sendLobbyBroadcast(event, payload, { queue = true } = {}) {
    if (!lobbyChannel) return false;

    if (!canPushBroadcast(lobbyChannel, lobbySubscribed)) {
      if (queue) {
        pendingLobbyBroadcasts = enqueueBroadcast(pendingLobbyBroadcasts, {
          event,
          payload,
        });
      }
      return false;
    }

    lobbyChannel
      .send({ type: "broadcast", event, payload })
      .catch((error) => console.warn("Lobby broadcast gagal:", error));
    return true;
  }

  function sendRoomBroadcast(
    event,
    payload,
    { queue = true, httpFallback = false } = {},
  ) {
    if (!roomChannel) return false;

    if (!canPushBroadcast(roomChannel, roomSubscribed)) {
      if (queue) {
        pendingRoomBroadcasts = enqueueBroadcast(pendingRoomBroadcasts, {
          event,
          payload,
        });
      }
      if (httpFallback) {
        sendRoomHttpBroadcast(event, payload);
        return true;
      }
      return false;
    }

    roomChannel
      .send({ type: "broadcast", event, payload })
      .catch((error) => console.warn("Room broadcast gagal:", error));
    return true;
  }

  function sendRoomHttpBroadcast(event, payload) {
    if (typeof roomChannel?.httpSend !== "function") return false;

    roomChannel
      .httpSend(event, payload, { timeout: BROADCAST_HTTP_TIMEOUT_MS })
      .catch((error) => console.warn("Room HTTP broadcast gagal:", error));
    return true;
  }

  function canPushBroadcast(channel, subscribed) {
    if (!channel || !subscribed) return false;

    const canPush = channel.channelAdapter?.canPush;
    return typeof canPush === "function" ? canPush.call(channel.channelAdapter) : true;
  }

  function enqueueBroadcast(queue, item) {
    const nextQueue = [...queue, item];
    return nextQueue.length > 24 ? nextQueue.slice(nextQueue.length - 24) : nextQueue;
  }

  function flushLobbyBroadcasts() {
    if (!pendingLobbyBroadcasts.length) return;
    const broadcasts = pendingLobbyBroadcasts;
    pendingLobbyBroadcasts = [];

    for (const broadcast of broadcasts) {
      sendLobbyBroadcast(broadcast.event, broadcast.payload, { queue: false });
    }
  }

  function flushRoomBroadcasts() {
    if (!pendingRoomBroadcasts.length) return;
    const broadcasts = pendingRoomBroadcasts;
    pendingRoomBroadcasts = [];

    for (const broadcast of broadcasts) {
      sendRoomBroadcast(broadcast.event, broadcast.payload, { queue: false });
    }
  }

  function trackLobbyPresence(overrides = {}) {
    if (!lobbyChannel) return;
    const profile = getProfile?.() || {};
    const payload = {
      playerId,
      username: profile.username || "Player",
      avatar: profile.avatar || "",
      bio: profile.bio || "",
      guest: Boolean(profile.guest),
      roomCode:
        overrides.roomCode !== undefined
          ? overrides.roomCode
          : currentRoomCode || "",
      roomStatus:
        overrides.roomStatus !== undefined
          ? overrides.roomStatus
          : currentRoomCode
            ? roomStatus
            : "",
      roomEndsAt:
        overrides.roomEndsAt !== undefined
          ? overrides.roomEndsAt
          : currentRoomCode
            ? roomEndsAt
            : null,
      joinedAt,
      presenceRevision: ++presenceRevision,
      updatedAt: Date.now(),
    };
    lobbyChannel.track(payload);
    sendLobbyBroadcast("presence:refresh", {}, { queue: false });
  }

  function syncLobbyRoomStatus() {
    if (!currentRoomCode) return;
    trackLobbyPresence({ roomStatus, roomEndsAt });
  }

  function trackRoomPresence(overrides = {}) {
    if (!roomChannel) return;
    const profile = getProfile?.() || {};
    const payload = {
      playerId,
      username: profile.username || "Player",
      avatar: profile.avatar || "",
      bio: profile.bio || "",
      guest: Boolean(profile.guest),
      ready: overrides.ready ?? playerState.ready,
      score: overrides.score ?? playerState.score,
      effect: overrides.effect ?? playerState.effect,
      scoreUpdatedAt: overrides.scoreUpdatedAt ?? playerState.scoreUpdatedAt,
      scoreRevision: overrides.scoreRevision ?? playerState.scoreRevision,
      finished: overrides.finished ?? playerState.finished,
      finishedAt: overrides.finishedAt ?? playerState.finishedAt,
      roomStatus: overrides.roomStatus ?? roomStatus,
      roomEndsAt: overrides.roomEndsAt ?? roomEndsAt,
      joinedAt,
      presenceRevision: ++presenceRevision,
      updatedAt: Date.now(),
    };
    roomChannel.track(payload);
    sendRoomBroadcast("presence:refresh", {}, { queue: false });
  }

  function buildRoomSummaries(entries) {
    const rooms = new Map();
    for (const entry of getLatestPresenceEntries(entries)) {
      const code = String(entry.roomCode || "").trim();
      if (!code) continue;

      const playerIdValue = String(entry.playerId || "");
      if (!playerIdValue) continue;

      const entryJoinedAt = entry.joinedAt || Date.now();
      const entryRevision = Number(entry.presenceRevision || 0);
      const entryUpdatedAt = entry.updatedAt || entryJoinedAt;
      const entryOrder = entryRevision || entryUpdatedAt;

      const room = rooms.get(code) || {
        code,
        host: entry.username || "Host",
        hostId: entry.playerId,
        hostJoinedAt: entryJoinedAt,
        players: new Map(),
        maxPlayers: MAX_ROOM_PLAYERS,
        status: entry.roomStatus || "waiting",
      };

      const existingPlayer = room.players.get(playerIdValue);
      const existingRevision = Number(existingPlayer?.presenceRevision || 0);
      const existingUpdatedAt = existingPlayer?.updatedAt ?? -1;
      const existingOrder = existingRevision || existingUpdatedAt;

      if (!existingPlayer || entryOrder > existingOrder) {
        room.players.set(playerIdValue, {
          joinedAt: entryJoinedAt,
          presenceRevision: entryRevision,
          updatedAt: entryUpdatedAt,
          username: entry.username || "Host",
          roomStatus: entry.roomStatus || "waiting",
          playerId: playerIdValue,
        });
      }

      if ((entryJoinedAt || 0) < (room.hostJoinedAt || 0)) {
        room.host = entry.username || "Host";
        room.hostId = entry.playerId;
        room.hostJoinedAt = entryJoinedAt || room.hostJoinedAt;
      }

      room.status = entry.roomStatus || room.status;
      rooms.set(code, room);
    }

    return [...rooms.values()]
      .filter((room) => room.status === "waiting")
      .sort((a, b) => (b.hostJoinedAt || 0) - (a.hostJoinedAt || 0))
      .map((room) => ({
        code: room.code,
        host: room.host,
        players: room.players.size,
        maxPlayers: room.maxPlayers,
        status: room.status,
      }));
  }

  function clearJoinValidation() {
    if (joinValidationTimer) {
      clearTimeout(joinValidationTimer);
      joinValidationTimer = null;
    }
  }

  function getLatestPresenceEntries(entries) {
    const latestEntries = new Map();

    for (const entry of entries) {
      const playerIdValue = String(entry.playerId || "");
      if (!playerIdValue) continue;

      const existing = latestEntries.get(playerIdValue);
      if (!existing || getPresenceOrder(entry) > getPresenceOrder(existing)) {
        latestEntries.set(playerIdValue, entry);
      }
    }

    return [...latestEntries.values()];
  }

  function getPresenceOrder(entry) {
    return (
      Number(entry.presenceRevision || 0) ||
      Number(entry.updatedAt || 0) ||
      Number(entry.joinedAt || 0)
    );
  }

  function buildRoomFromPresence(entries) {
    if (!currentRoomCode) return null;
    const playersMap = new Map();

    for (const entry of entries) {
      const id = String(entry.playerId || "");
      if (!id) continue;

      const joinedAt = entry.joinedAt || Date.now();
      const presenceRevision = Number(entry.presenceRevision || 0);
      const updatedAt = entry.updatedAt || joinedAt;
      const entryOrder = presenceRevision || updatedAt;
      const existing = playersMap.get(id);
      const existingOrder =
        Number(existing?.presenceRevision || 0) || existing?.updatedAt || 0;
      if (existing && existingOrder >= entryOrder) {
        continue;
      }

      playersMap.set(id, {
        id,
        username: entry.username || "Player",
        avatar: entry.avatar || "",
        bio: entry.bio || "",
        guest: Boolean(entry.guest),
        ready: Boolean(entry.ready),
        score: normalizeScoreValue(entry.score),
        effect: entry.effect || "Menunggu",
        scoreUpdatedAt: Number(entry.scoreUpdatedAt || entry.updatedAt || 0),
        scoreRevision: Number(entry.scoreRevision || 0),
        finished: Boolean(entry.finished),
        finishedAt: entry.finishedAt || null,
        joinedAt,
        presenceRevision,
        updatedAt,
        roomStatus: entry.roomStatus || "waiting",
        roomEndsAt: entry.roomEndsAt || null,
      });
    }

    const players = [...playersMap.values()].map((player) =>
      mergeCachedScore(player),
    );

    if (!players.length) return null;

    const host = [...players].sort(
      (a, b) => (a.joinedAt || 0) - (b.joinedAt || 0),
    )[0];
    const status = roomStatus === "ended" ? "ended" : host.roomStatus || "waiting";
    const endsAt = host.roomEndsAt || null;
    const orderedPlayers = [...players].sort((a, b) => {
      if (a.id === host.id) return -1;
      if (b.id === host.id) return 1;
      return (a.joinedAt || 0) - (b.joinedAt || 0);
    });

    roomStatus = status;
    roomEndsAt = endsAt;

    return {
      code: currentRoomCode,
      hostId: host.id,
      status,
      endsAt,
      players: orderedPlayers.map((player) => ({
        id: player.id,
        username: player.username,
        avatar: player.avatar,
        bio: player.bio,
        guest: player.guest,
        ready: player.ready,
        score: player.score,
        effect: player.effect,
        scoreUpdatedAt: player.scoreUpdatedAt || player.updatedAt || 0,
        scoreRevision: player.scoreRevision || 0,
        finished: Boolean(player.finished),
        finishedAt: player.finishedAt || null,
        host: player.id === host.id,
      })),
      leaderboard: getLeaderboard(orderedPlayers),
    };
  }

  function ensureRoomTimer() {
    if (roomTimer || roomStatus !== "playing" || !roomEndsAt) return;
    const safetyEndsAt = roomEndsAt + MAX_BONUS_TIME_MS + GAME_END_GRACE_MS;
    const delay = Math.max(0, safetyEndsAt - Date.now());
    roomTimer = setTimeout(() => {
      roomTimer = null;
      endGame({ force: true });
    }, delay);
  }

  function clearRoomTimer() {
    if (roomTimer) {
      clearTimeout(roomTimer);
      roomTimer = null;
    }
  }

  function startStateAnnounce() {
    clearStateAnnounce();

    stateAnnounceTimer = setInterval(() => {
      if (!roomChannel || !currentRoomCode || roomStatus !== "playing") {
        clearStateAnnounce();
        return;
      }

      announcePlayerState("tick");
      const room = buildRoomFromPresence(getRoomPresence());
      if (room) {
        emitRoomUpdate(room);
        endGameIfEveryoneFinished(room);
      }
    }, 650);
  }

  function clearStateAnnounce() {
    if (stateAnnounceTimer) {
      clearInterval(stateAnnounceTimer);
      stateAnnounceTimer = null;
    }
  }

  function scheduleScorePresenceSync() {
    const elapsed = Date.now() - lastScorePresenceSyncAt;

    if (elapsed >= SCORE_PRESENCE_SYNC_MS) {
      clearScorePresenceSync();
      lastScorePresenceSyncAt = Date.now();
      trackRoomPresence();
      return;
    }

    if (scorePresenceTimer) return;

    scorePresenceTimer = setTimeout(() => {
      scorePresenceTimer = null;
      lastScorePresenceSyncAt = Date.now();
      trackRoomPresence();
    }, SCORE_PRESENCE_SYNC_MS - elapsed);
  }

  function clearScorePresenceSync() {
    if (scorePresenceTimer) {
      clearTimeout(scorePresenceTimer);
      scorePresenceTimer = null;
    }
    lastScorePresenceSyncAt = 0;
  }

  function startFinishAnnounce() {
    clearFinishAnnounce();
    let remainingAnnouncements = 4;

    finishAnnounceTimer = setInterval(() => {
      if (roomStatus !== "playing" || !playerState.finished) {
        clearFinishAnnounce();
        return;
      }

      announcePlayerFinished();
      remainingAnnouncements -= 1;
      if (remainingAnnouncements <= 0) {
        clearFinishAnnounce();
      }
    }, 700);
  }

  function clearFinishAnnounce() {
    if (finishAnnounceTimer) {
      clearInterval(finishAnnounceTimer);
      finishAnnounceTimer = null;
    }
  }

  function announcePlayerFinished() {
    if (!roomChannel || !currentRoomCode || !playerState.finished) return;

    sendRoomBroadcast(
      "game:finished",
      {
        playerId,
        finishedAt: playerState.finishedAt || Date.now(),
        score: playerState.score,
        effect: playerState.effect,
        scoreRevision: playerState.scoreRevision,
        player: getLocalPlayerSnapshot(),
        finishedPlayers: getFinishedSnapshot(),
      },
      { httpFallback: true },
    );
  }

  function announcePlayerState(reason = "sync") {
    if (!roomChannel || !currentRoomCode || roomStatus !== "playing") return;

    sendRoomBroadcast(
      "game:state",
      {
        reason,
        sentAt: Date.now(),
        player: getLocalPlayerSnapshot(),
        finishedPlayers: getFinishedSnapshot(),
      },
      { queue: false, httpFallback: true },
    );
  }

  function getLocalPlayerSnapshot() {
    const profile = getProfile?.() || {};
    return {
      id: playerId,
      username: profile.username || "Player",
      avatar: profile.avatar || "",
      bio: profile.bio || "",
      guest: Boolean(profile.guest),
      ready: playerState.ready,
      score: normalizeScoreValue(playerState.score),
      effect: playerState.effect || "Normal",
      scoreUpdatedAt: playerState.scoreUpdatedAt || Date.now(),
      scoreRevision: playerState.scoreRevision || 0,
      finished: Boolean(playerState.finished),
      finishedAt: playerState.finishedAt || null,
      joinedAt,
      roomStatus,
      roomEndsAt,
      updatedAt: Date.now(),
    };
  }

  function getFinishedSnapshot() {
    const finishedPlayers = [...finishedCache.entries()].map(([id, value]) => ({
      id,
      finishedAt: value.finishedAt,
    }));

    if (playerState.finished && !finishedPlayers.some((player) => player.id === playerId)) {
      finishedPlayers.push({
        id: playerId,
        finishedAt: playerState.finishedAt || Date.now(),
      });
    }

    return finishedPlayers;
  }

  function applyPlayerSnapshots(payload) {
    if (payload?.player) {
      applyPlayerSnapshot(payload.player, { allowScore: true });
    }

    if (Array.isArray(payload?.players)) {
      for (const player of payload.players) {
        applyPlayerSnapshot(player, { allowScore: false });
      }
    }

    if (Array.isArray(payload?.finishedPlayers)) {
      for (const player of payload.finishedPlayers) {
        applyPlayerSnapshot({ ...player, finished: true }, { allowScore: false });
      }
    }
  }

  function applyPlayerSnapshot(player, { allowScore }) {
    const snapshotPlayerId = String(player?.id || player?.playerId || "");
    if (!snapshotPlayerId) return;

    const scoreUpdatedAt =
      Number(player.scoreUpdatedAt || player.updatedAt || 0) || Date.now();
    const scoreRevision = Number(player.scoreRevision || 0);
    const snapshotScore = Number(player.score);
    if (allowScore && Number.isFinite(snapshotScore)) {
      rememberScore(
        snapshotPlayerId,
        snapshotScore,
        player.effect || "Normal",
        scoreUpdatedAt,
        scoreRevision,
      );
    }

    if (player.finished) {
      const finishedAt =
        Number(player.finishedAt || player.updatedAt || 0) || Date.now();
      rememberFinished(snapshotPlayerId, finishedAt, finishedAt);
    }
  }

  function endGame({ force = false, room: roomSnapshot = null } = {}) {
    if (!roomChannel || roomStatus !== "playing") return;
    const room = roomSnapshot || buildRoomFromPresence(getRoomPresence());
    if (!room) return;
    if (!force && !room.players.every((player) => player.finished)) return;

    const now = Date.now();
    const players = room.players.map((player) => ({
      ...mergeCachedScore(player),
      finished: true,
      finishedAt: player.finishedAt || now,
      effect: "Selesai",
    }));
    completeRoomGame({
      room,
      players,
      leaderboard: getLeaderboard(players),
      endedAt: now,
      broadcast: true,
    });
  }

  function completeRoomGame({ room, players, leaderboard, endedAt, broadcast }) {
    clearRoomTimer();
    clearStateAnnounce();
    clearFinishAnnounce();
    clearScorePresenceSync();
    roomStatus = "ended";
    roomEndsAt = endedAt;
    playerState.finished = true;
    playerState.finishedAt = playerState.finishedAt || endedAt;
    playerState.effect = "Selesai";
    rememberFinished(playerId, playerState.finishedAt, endedAt);
    trackRoomPresence({
      roomStatus,
      roomEndsAt: endedAt,
      finished: true,
      finishedAt: playerState.finishedAt,
      effect: playerState.effect,
      scoreRevision: playerState.scoreRevision,
    });
    syncLobbyRoomStatus();

    const endedRoom = room
      ? {
          ...room,
          status: "ended",
          endsAt: endedAt,
          players,
          leaderboard,
        }
      : null;

    if (endedRoom) {
      onMessage?.({ type: "room:update", payload: { room: endedRoom } });
    }

    onMessage?.({ type: "game:ended", payload: { leaderboard } });

    if (broadcast) {
      sendRoomBroadcast(
        "game:ended",
        { leaderboard, endsAt: endedAt },
        { httpFallback: true },
      );
    }
  }

  return {
    connect,
    disconnect,
    send,
    sendNow,
    getStatus,
    clearPendingMessages,
  };
}

function flattenPresenceState(state) {
  const entries = [];
  for (const metas of Object.values(state)) {
    if (Array.isArray(metas)) {
      for (const meta of metas) {
        entries.push(meta);
      }
    }
  }
  return entries;
}

function getLeaderboard(players) {
  return [...players]
    .map((player) => ({
      id: player.id,
      username: player.username,
      avatar: player.avatar,
      guest: player.guest,
      score: normalizeScoreValue(player.score),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.username).localeCompare(String(b.username)),
    );
}

function normalizeScoreDelta(value) {
  const points = Number(value);
  if (!Number.isFinite(points)) return 0;

  return Math.max(MIN_SCORE_DELTA, Math.min(MAX_SCORE_DELTA, Math.round(points)));
}

function normalizeScoreValue(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;

  return Math.max(0, Math.round(score));
}

function createRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (!code || code.length < 6);
  return code;
}
