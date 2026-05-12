import { createClient } from "@supabase/supabase-js";

const DEFAULT_LOBBY_CHANNEL = "lobby";
const MAX_ROOM_PLAYERS = 6;
const GAME_DURATION_MS = 60_000;
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
  let connected = false;
  let roomStatus = "waiting";
  let roomEndsAt = null;
  let roomTimer = null;
  let joinValidationTimer = null;
  let joinedAt = Date.now();
  let presenceRevision = 0;
  let scoreCache = new Map();
  let playerState = {
    ready: false,
    score: 0,
    effect: "Menunggu",
    scoreUpdatedAt: Date.now(),
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
        if (status !== "SUBSCRIBED") return;
        connected = true;
        trackLobbyPresence();
        onOpen?.();
        onMessage?.({ type: "connected", payload: { playerId } });
        handleLobbySync();
      });
  }

  function disconnect() {
    clearRoomTimer();
    clearJoinValidation();
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
    playerState = {
      ready: true,
      score: 0,
      effect: "Menunggu",
      scoreUpdatedAt: Date.now(),
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
    }

    currentRoomCode = code;
    roomStatus = "waiting";
    roomEndsAt = null;
    clearRoomTimer();
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

    roomChannel = supabase.channel(`room:${code}`, {
      config: { presence: { key: playerId } },
    });

    roomChannel
      .on("presence", { event: "sync" }, handleRoomSync)
      .on("broadcast", { event: "presence:refresh" }, handleRoomSync)
      .on("broadcast", { event: "game:score" }, handleRoomScoreBroadcast)
      .on("broadcast", { event: "game:started" }, (event) => {
        const now = Date.now();
        const endsAt =
          Number(event.payload?.endsAt || 0) || now + GAME_DURATION_MS;
        roomStatus = "playing";
        roomEndsAt = endsAt;
        scoreCache.clear();
        playerState.score = 0;
        playerState.effect = "Normal";
        playerState.scoreUpdatedAt = now;
        rememberScore(playerId, playerState.score, playerState.effect, now);
        trackRoomPresence();
        syncLobbyRoomStatus();
        handleRoomSync();
      })
      .on("broadcast", { event: "game:ended" }, () => {
        roomStatus = "ended";
        trackRoomPresence();
        syncLobbyRoomStatus();
        handleRoomSync();
      })
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        trackRoomPresence();
        syncLobbyRoomStatus();
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
    clearJoinValidation();
    if (roomChannel) {
      roomChannel.unsubscribe();
      roomChannel = null;
    }

    currentRoomCode = null;
    roomStatus = "waiting";
    roomEndsAt = null;
    scoreCache.clear();
    playerState.ready = false;
    playerState.score = 0;
    playerState.effect = "Menunggu";
    playerState.scoreUpdatedAt = Date.now();

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
    scoreCache.clear();
    playerState.score = 0;
    playerState.effect = "Normal";
    playerState.scoreUpdatedAt = now;
    rememberScore(playerId, playerState.score, playerState.effect, now);
    trackRoomPresence({
      roomStatus,
      roomEndsAt,
      score: playerState.score,
      effect: playerState.effect,
      scoreUpdatedAt: now,
    });
    syncLobbyRoomStatus();

    roomChannel.send({
      type: "broadcast",
      event: "game:started",
      payload: { endsAt: roomEndsAt },
    });

    ensureRoomTimer();
    handleRoomSync();
  }

  function addScore(points, effect) {
    if (!roomChannel || !currentRoomCode) return;
    if (roomStatus !== "playing") return;

    const boundedPoints = normalizeScoreDelta(points);
    const now = Date.now();
    playerState.score = Math.max(0, (playerState.score || 0) + boundedPoints);
    playerState.effect = String(effect || "Normal").slice(0, 24);
    playerState.scoreUpdatedAt = now;
    rememberScore(playerId, playerState.score, playerState.effect, now);
    trackRoomPresence();
    roomChannel.send({
      type: "broadcast",
      event: "game:score",
      payload: {
        playerId,
        points: boundedPoints,
        score: playerState.score,
        effect: playerState.effect,
        scoreUpdatedAt: now,
      },
    });
    emitOptimisticRoomUpdate();
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
      onMessage?.({ type: "game:started", payload: { room } });
    }

    if (room.status === "ended") {
      const leaderboard = getLeaderboard(room.players);
      onMessage?.({ type: "game:ended", payload: { leaderboard } });
    }

    onMessage?.({ type: "room:update", payload: { room } });
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

    if (Number.isFinite(broadcastScore)) {
      rememberScore(
        targetPlayerId,
        Math.max(0, Math.round(broadcastScore)),
        broadcastEffect,
        scoreUpdatedAt,
      );
    }

    const room = buildRoomFromPresence(getRoomPresence());
    if (!room) return;

    room.players = room.players.map((player) => mergeCachedScore(player));
    room.leaderboard = getLeaderboard(room.players);

    onMessage?.({ type: "room:update", payload: { room } });
  }

  function rememberScore(playerIdValue, score, effect, updatedAt = Date.now()) {
    const normalizedScore = normalizeScoreValue(score);
    const parsedUpdatedAt = Number(updatedAt);
    const normalizedUpdatedAt = Number.isFinite(parsedUpdatedAt)
      ? parsedUpdatedAt
      : Date.now();
    const previous = scoreCache.get(playerIdValue);

    if (previous && previous.updatedAt > normalizedUpdatedAt) return;

    scoreCache.set(playerIdValue, {
      score: normalizedScore,
      effect: String(effect || "Normal").slice(0, 24),
      updatedAt: normalizedUpdatedAt,
    });
  }

  function mergeCachedScore(player) {
    const score = normalizeScoreValue(player.score);
    const presenceUpdatedAt =
      Number(player.scoreUpdatedAt || player.updatedAt || 0) || 0;
    const cached = scoreCache.get(player.id);

    if (!cached || presenceUpdatedAt >= cached.updatedAt) {
      rememberScore(player.id, score, player.effect, presenceUpdatedAt);
      return { ...player, score };
    }

    return {
      ...player,
      score: cached.score,
      effect: cached.effect || player.effect,
    };
  }

  function getLobbyPresence() {
    return flattenPresenceState(lobbyChannel?.presenceState?.() || {});
  }

  function getRoomPresence() {
    return flattenPresenceState(roomChannel?.presenceState?.() || {});
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
    lobbyChannel.send({
      type: "broadcast",
      event: "presence:refresh",
      payload: {},
    });
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
      roomStatus: overrides.roomStatus ?? roomStatus,
      roomEndsAt: overrides.roomEndsAt ?? roomEndsAt,
      joinedAt,
      presenceRevision: ++presenceRevision,
      updatedAt: Date.now(),
    };
    roomChannel.track(payload);
    roomChannel.send({
      type: "broadcast",
      event: "presence:refresh",
      payload: {},
    });
  }

  function buildRoomSummaries(entries) {
    const rooms = new Map();
    for (const entry of entries) {
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
    const status = host.roomStatus || "waiting";
    const endsAt = host.roomEndsAt || null;

    roomStatus = status;
    roomEndsAt = endsAt;

    return {
      code: currentRoomCode,
      hostId: host.id,
      status,
      endsAt,
      players: players.map((player) => ({
        id: player.id,
        username: player.username,
        avatar: player.avatar,
        bio: player.bio,
        guest: player.guest,
        ready: player.ready,
        score: player.score,
        effect: player.effect,
        host: player.id === host.id,
      })),
      leaderboard: getLeaderboard(players),
    };
  }

  function ensureRoomTimer() {
    if (roomTimer || roomStatus !== "playing" || !roomEndsAt) return;
    const delay = Math.max(0, roomEndsAt - Date.now());
    roomTimer = setTimeout(() => {
      roomTimer = null;
      endGame();
    }, delay);
  }

  function clearRoomTimer() {
    if (roomTimer) {
      clearTimeout(roomTimer);
      roomTimer = null;
    }
  }

  function endGame() {
    if (!roomChannel || roomStatus !== "playing") return;
    const room = buildRoomFromPresence(getRoomPresence());
    if (!room || room.hostId !== playerId) return;

    roomStatus = "ended";
    trackRoomPresence({ roomStatus, roomEndsAt: Date.now() });
    syncLobbyRoomStatus();

    roomChannel.send({
      type: "broadcast",
      event: "game:ended",
      payload: {},
    });

    handleRoomSync();
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
