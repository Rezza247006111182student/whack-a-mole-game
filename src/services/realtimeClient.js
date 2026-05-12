import { createClient } from "@supabase/supabase-js";

const DEFAULT_LOBBY_CHANNEL = "lobby";
const MAX_ROOM_PLAYERS = 6;
const GAME_DURATION_MS = 60_000;

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
  let intentionalDisconnect = false;
  let roomStatus = "waiting";
  let roomEndsAt = null;
  let roomTimer = null;
  let joinedAt = Date.now();
  let playerState = {
    ready: false,
    score: 0,
    effect: "Menunggu",
  };

  function connect() {
    if (!supabaseUrl || !supabaseAnonKey) {
      onDisabled?.();
      return;
    }

    if (lobbyChannel) return;

    intentionalDisconnect = false;
    supabase = createClient(supabaseUrl, supabaseAnonKey);
    lobbyChannel = supabase.channel(lobbyChannelName, {
      config: { presence: { key: playerId } },
    });

    lobbyChannel
      .on("presence", { event: "sync" }, handleLobbySync)
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
    intentionalDisconnect = true;
    clearRoomTimer();
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
        addScore(Number(payload.points || 0), payload.effect || "Normal");
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
    playerState = { ready: true, score: 0, effect: "Menunggu" };
    joinRoom(code, { host: true });
  }

  function joinRoom(code, options = {}) {
    if (!code) return;

    const rooms = buildRoomSummaries(getLobbyPresence());
    const existingRoom = rooms.find((room) => room.code === code);

    if (!options.host && !existingRoom) {
      onMessage?.({
        type: "error",
        payload: { message: "Room tidak ditemukan." },
      });
      return;
    }

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

    currentRoomCode = code;
    roomStatus = "waiting";
    roomEndsAt = null;
    clearRoomTimer();

    if (roomChannel) {
      roomChannel.unsubscribe();
      roomChannel = null;
    }

    roomChannel = supabase.channel(`room:${code}`, {
      config: { presence: { key: playerId } },
    });

    roomChannel
      .on("presence", { event: "sync" }, handleRoomSync)
      .on("broadcast", { event: "game:started" }, (event) => {
        const endsAt =
          Number(event.payload?.endsAt || 0) || Date.now() + GAME_DURATION_MS;
        roomStatus = "playing";
        roomEndsAt = endsAt;
        playerState.score = 0;
        playerState.effect = "Normal";
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
      });
  }

  function leaveRoom() {
    clearRoomTimer();
    if (roomChannel) {
      roomChannel.unsubscribe();
      roomChannel = null;
    }

    currentRoomCode = null;
    roomStatus = "waiting";
    roomEndsAt = null;
    playerState.ready = false;
    playerState.score = 0;
    playerState.effect = "Menunggu";

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

    roomStatus = "playing";
    roomEndsAt = Date.now() + GAME_DURATION_MS;
    trackRoomPresence({ roomStatus, roomEndsAt });
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

    const boundedPoints = Math.max(-10, Math.min(20, Math.round(points)));
    playerState.score = Math.max(0, (playerState.score || 0) + boundedPoints);
    playerState.effect = String(effect || "Normal").slice(0, 24);
    trackRoomPresence();
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
    };
    lobbyChannel.track(payload);
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
      roomStatus: overrides.roomStatus ?? roomStatus,
      roomEndsAt: overrides.roomEndsAt ?? roomEndsAt,
      joinedAt,
    };
    roomChannel.track(payload);
  }

  function buildRoomSummaries(entries) {
    const rooms = new Map();
    for (const entry of entries) {
      const code = String(entry.roomCode || "").trim();
      if (!code) continue;

      const room = rooms.get(code) || {
        code,
        host: entry.username || "Host",
        hostId: entry.playerId,
        hostJoinedAt: entry.joinedAt || Date.now(),
        players: 0,
        maxPlayers: MAX_ROOM_PLAYERS,
        status: entry.roomStatus || "waiting",
      };

      room.players += 1;
      if ((entry.joinedAt || 0) < (room.hostJoinedAt || 0)) {
        room.host = entry.username || "Host";
        room.hostId = entry.playerId;
        room.hostJoinedAt = entry.joinedAt || room.hostJoinedAt;
        room.status = entry.roomStatus || room.status;
      }

      rooms.set(code, room);
    }

    return [...rooms.values()]
      .filter((room) => room.status === "waiting")
      .sort((a, b) => (b.hostJoinedAt || 0) - (a.hostJoinedAt || 0))
      .map((room) => ({
        code: room.code,
        host: room.host,
        players: room.players,
        maxPlayers: room.maxPlayers,
        status: room.status,
      }));
  }

  function buildRoomFromPresence(entries) {
    if (!currentRoomCode) return null;
    const players = entries.map((entry) => ({
      id: entry.playerId,
      username: entry.username || "Player",
      avatar: entry.avatar || "",
      bio: entry.bio || "",
      guest: Boolean(entry.guest),
      ready: Boolean(entry.ready),
      score: Number(entry.score || 0),
      effect: entry.effect || "Menunggu",
      joinedAt: entry.joinedAt || Date.now(),
      roomStatus: entry.roomStatus || "waiting",
      roomEndsAt: entry.roomEndsAt || null,
    }));

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
      score: Number(player.score || 0),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.username).localeCompare(String(b.username)),
    );
}

function createRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (!code || code.length < 6);
  return code;
}
