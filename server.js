const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const GAME_DURATION_MS = 60_000;
const MAX_BONUS_TIME_MS = 60_000;
const GAME_END_GRACE_MS = 5_000;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg"
};

const clients = new Map();
const rooms = new Map();

const USERNAME_BAD_WORDS = [
  "anjing",
  "bangsat",
  "babi",
  "kontol",
  "memek",
  "ngentot",
  "tolol",
  "goblok"
];

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

  if (urlPath.startsWith("/api/")) {
    await handleApiRequest(req, res, urlPath);
    return;
  }

  if (urlPath === "/config.js") {
    const config = getPublicConfig();
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(`window.APP_CONFIG = Object.freeze(${JSON.stringify(config)});\n`);
    return;
  }

  const requestedPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  const client = {
    id: createId("p"),
    socket,
    profile: {
      username: "Player",
      avatar: "",
      bio: "",
      guest: true
    },
    roomCode: null
  };

  clients.set(client.id, client);
  send(client, "connected", { playerId: client.id });
  sendRoomList(client);

  socket.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(client, "error", { message: "Format pesan tidak valid." });
      return;
    }

    handleMessage(client, message);
  });

  socket.on("close", () => {
    leaveRoom(client);
    clients.delete(client.id);
  });
});

function handleMessage(client, message) {
  switch (message.type) {
    case "profile:update":
      client.profile = {
        ...client.profile,
        username: cleanText(message.payload?.username || client.profile.username).slice(0, 20),
        avatar: cleanText(message.payload?.avatar || client.profile.avatar).slice(0, 400),
        bio: cleanText(message.payload?.bio || client.profile.bio).slice(0, 120),
        guest: Boolean(message.payload?.guest)
      };
      send(client, "profile:updated", { playerId: client.id, profile: client.profile });
      syncClientRoom(client);
      break;

    case "rooms:list":
      sendRoomList(client);
      break;

    case "room:create":
      createRoom(client);
      break;

    case "room:join":
      joinRoom(client, cleanText(message.payload?.code || "").toUpperCase());
      break;

    case "room:leave":
      leaveRoom(client);
      sendRoomList(client);
      break;

    case "room:ready":
      setReady(client, Boolean(message.payload?.ready));
      break;

    case "game:start":
      startGame(client);
      break;

    case "game:score":
      addScore(client, Number(message.payload?.points || 0), message.payload?.effect || null);
      break;

    case "game:finished":
      finishPlayerGame(client);
      break;

    case "game:exit":
      leaveRoom(client);
      sendRoomList(client);
      break;

    default:
      send(client, "error", { message: "Tipe pesan belum dikenali." });
  }
}

function createRoom(client) {
  leaveRoom(client);

  const code = createRoomCode();
  const room = {
    code,
    hostId: client.id,
    status: "waiting",
    createdAt: Date.now(),
    endsAt: null,
    timer: null,
    players: new Map()
  };

  room.players.set(client.id, createRoomPlayer(client, true));
  rooms.set(code, room);
  client.roomCode = code;
  broadcastRoom(room);
  broadcastRoomList();
}

function joinRoom(client, code) {
  const room = rooms.get(code);

  if (!room) {
    send(client, "error", { message: "Room tidak ditemukan." });
    return;
  }

  if (room.status !== "waiting") {
    send(client, "error", { message: "Room sedang bermain. Coba room lain." });
    return;
  }

  if (room.players.size >= 6) {
    send(client, "error", { message: "Room sudah penuh." });
    return;
  }

  leaveRoom(client);
  room.players.set(client.id, createRoomPlayer(client, false));
  client.roomCode = code;
  broadcastRoom(room);
  broadcastRoomList();
}

function leaveRoom(client) {
  const room = getClientRoom(client);
  if (!room) return;

  room.players.delete(client.id);
  client.roomCode = null;

  if (room.players.size === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    broadcastRoomList();
    return;
  }

  if (room.hostId === client.id) {
    const nextHost = room.players.keys().next().value;
    room.hostId = nextHost;
  }

  if (room.status === "waiting") {
    for (const player of room.players.values()) {
      player.ready = false;
      player.host = player.id === room.hostId;
    }
  }

  if (room.status === "playing" && areAllPlayersFinished(room)) {
    endGame(room.code);
    return;
  }

  broadcastRoom(room);
  broadcastRoomList();
}

function setReady(client, ready) {
  const room = getClientRoom(client);
  if (!room || room.status !== "waiting") return;

  const player = room.players.get(client.id);
  if (!player) return;

  player.ready = ready;
  broadcastRoom(room);
}

function startGame(client) {
  const room = getClientRoom(client);
  if (!room || room.status !== "waiting" || room.hostId !== client.id) return;

  const players = [...room.players.values()];
  const everyoneReady = players.length > 0 && players.every((player) => player.ready);
  if (!everyoneReady) {
    send(client, "error", { message: "Semua pemain harus ready dulu." });
    return;
  }

  room.status = "playing";
  room.endsAt = Date.now() + GAME_DURATION_MS;

  for (const player of room.players.values()) {
    player.score = 0;
    player.ready = false;
    player.finished = false;
    player.finishedAt = null;
    player.effect = "Normal";
    player.host = player.id === room.hostId;
  }

  broadcastRoom(room);
  broadcast(room, "game:started", { room: serializeRoom(room) });
  broadcastRoomList();

  clearTimeout(room.timer);
  room.timer = setTimeout(
    () => endGame(room.code, { force: true }),
    GAME_DURATION_MS + MAX_BONUS_TIME_MS + GAME_END_GRACE_MS,
  );
}

function addScore(client, points, effect) {
  const room = getClientRoom(client);
  if (!room || room.status !== "playing") return;
  if (Date.now() > room.endsAt + MAX_BONUS_TIME_MS + GAME_END_GRACE_MS) return;

  const player = room.players.get(client.id);
  if (!player) return;
  if (player.finished) return;

  const boundedPoints = Math.max(-10, Math.min(20, Math.round(points)));
  player.score = Math.max(0, player.score + boundedPoints);
  player.effect = cleanText(effect || player.effect || "Normal").slice(0, 24);
  broadcastRoom(room);
}

function finishPlayerGame(client) {
  const room = getClientRoom(client);
  if (!room || room.status !== "playing") return;

  const player = room.players.get(client.id);
  if (!player || player.finished) return;

  player.finished = true;
  player.finishedAt = Date.now();
  player.effect = "Menunggu hasil";
  broadcastRoom(room);

  if (areAllPlayersFinished(room)) {
    endGame(room.code);
  }
}

function areAllPlayersFinished(room) {
  const players = [...room.players.values()];
  return players.length > 0 && players.every((player) => player.finished);
}

function endGame(code, options = {}) {
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  if (!options.force && !areAllPlayersFinished(room)) return;

  clearTimeout(room.timer);
  room.timer = null;
  room.status = "ended";
  room.endsAt = Date.now();
  for (const player of room.players.values()) {
    player.ready = false;
    player.finished = true;
    player.finishedAt = player.finishedAt || Date.now();
    player.effect = "Selesai";
  }

  broadcastRoom(room);
  broadcast(room, "game:ended", { leaderboard: getLeaderboard(room) });
  broadcastRoomList();
}

function syncClientRoom(client) {
  const room = getClientRoom(client);
  if (!room) return;

  const player = room.players.get(client.id);
  if (!player) return;

  player.username = client.profile.username;
  player.avatar = client.profile.avatar;
  player.bio = client.profile.bio;
  player.guest = client.profile.guest;
  broadcastRoom(room);
}

function getClientRoom(client) {
  if (!client.roomCode) return null;
  return rooms.get(client.roomCode) || null;
}

function createRoomPlayer(client, ready) {
  return {
    id: client.id,
    username: client.profile.username,
    avatar: client.profile.avatar,
    bio: client.profile.bio,
    guest: client.profile.guest,
    host: false,
    ready,
    finished: false,
    finishedAt: null,
    score: 0,
    effect: "Menunggu"
  };
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    endsAt: room.endsAt,
    players: [...room.players.values()].map((player) => ({
      ...player,
      host: player.id === room.hostId
    })),
    leaderboard: getLeaderboard(room)
  };
}

function getLeaderboard(room) {
  return [...room.players.values()]
    .map((player) => ({
      id: player.id,
      username: player.username,
      avatar: player.avatar,
      guest: player.guest,
      score: player.score
    }))
    .sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
}

function getRoomSummaries() {
  return [...rooms.values()]
    .filter((room) => room.status === "waiting")
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((room) => ({
      code: room.code,
      host: room.players.get(room.hostId)?.username || "Host",
      players: room.players.size,
      maxPlayers: 6,
      status: room.status
    }));
}

function sendRoomList(client) {
  send(client, "rooms:list", { rooms: getRoomSummaries() });
}

function broadcastRoomList() {
  const payload = { rooms: getRoomSummaries() };
  for (const client of clients.values()) {
    send(client, "rooms:list", payload);
  }
}

function broadcastRoom(room) {
  broadcast(room, "room:update", { room: serializeRoom(room) });
}

function broadcast(room, type, payload) {
  for (const playerId of room.players.keys()) {
    const client = clients.get(playerId);
    if (client) send(client, type, payload);
  }
}

function send(client, type, payload = {}) {
  if (client.socket.readyState === client.socket.OPEN) {
    client.socket.send(JSON.stringify({ type, payload }));
  }
}

function createRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function createId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function cleanText(value) {
  return String(value).replace(/[<>]/g, "").trim();
}

async function handleApiRequest(req, res, urlPath) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, getCorsHeaders());
    res.end();
    return;
  }

  if (urlPath === "/api/moderate-username" && req.method === "POST") {
    await handleModerateUsername(req, res);
    return;
  }

  sendJson(res, 404, { error: "API route tidak ditemukan." });
}

async function handleModerateUsername(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { allowed: false, reason: "Body JSON tidak valid." });
    return;
  }

  const username = cleanText(body.username || "").slice(0, 40);
  if (!username) {
    sendJson(res, 400, { allowed: false, reason: "Username wajib diisi." });
    return;
  }

  const localResult = moderateUsernameLocally(username);
  if (!localResult.allowed) {
    sendJson(res, 200, localResult);
    return;
  }

  const apiKey = getEnv("GEMINI_API_KEY");
  if (!apiKey) {
    sendJson(res, 200, {
      allowed: true,
      source: "local",
      skippedAi: true,
      reason: "Gemini API key belum dikonfigurasi."
    });
    return;
  }

  try {
    const aiResult = await moderateUsernameWithGemini(username, apiKey);
    sendJson(res, 200, aiResult);
  } catch (error) {
    console.warn("Gemini username moderation gagal:", error.message);
    sendJson(res, 200, {
      allowed: true,
      source: "local",
      skippedAi: true,
      reason: "Moderasi AI tidak tersedia, fallback ke filter lokal."
    });
  }
}

function moderateUsernameLocally(username) {
  const value = username.trim().toLowerCase();
  if (value.length < 2) {
    return { allowed: false, source: "local", reason: "Username terlalu pendek." };
  }

  const blocked = USERNAME_BAD_WORDS.find((word) => value.includes(word));
  if (blocked) {
    return { allowed: false, source: "local", reason: "Username mengandung kata tidak pantas." };
  }

  return { allowed: true, source: "local", reason: "Username lolos filter lokal." };
}

async function moderateUsernameWithGemini(username, apiKey) {
  const model = getEnv("GEMINI_MODEL") || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    "Anda adalah moderator username untuk game anak/remaja berbahasa Indonesia.",
    "Tentukan apakah username mengandung kata kasar, seksual, kebencian, pelecehan, ancaman, atau penghinaan.",
    "Balas hanya JSON valid dengan format: {\"allowed\": boolean, \"reason\": string}.",
    `Username: ${username}`
  ].join("\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${text.slice(0, 160)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = JSON.parse(text);

  return {
    allowed: Boolean(parsed.allowed),
    source: "gemini",
    reason: String(parsed.reason || (parsed.allowed ? "Username aman." : "Username tidak pantas.")).slice(0, 180)
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) {
        reject(new Error("Body terlalu besar."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...getCorsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getPublicConfig() {
  return {
    appUrl: getEnv("VITE_APP_URL", "APP_URL") || `http://localhost:${PORT}`,
    supabaseUrl: getEnv("VITE_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_PROJECT_URL"),
    supabaseAnonKey: getEnv("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
    authRedirectUrl: getEnv("VITE_AUTH_REDIRECT_URL", "AUTH_REDIRECT_URL") || `http://localhost:${PORT}`,
    avatarBucket: getEnv("VITE_SUPABASE_AVATAR_BUCKET", "SUPABASE_AVATAR_BUCKET") || "avatars",
    wsUrl: getEnv("VITE_WS_URL", "VITE_WEBSOCKET_URL", "WS_URL"),
    realtimeMode: getEnv("VITE_REALTIME_MODE", "REALTIME_MODE") || "websocket"
  };
}

function getEnv(...keys) {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return "";
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} sudah dipakai. Tutup proses backend lama atau jalankan dengan PORT lain.`);
    console.error(`Contoh Windows: netstat -ano | findstr ":${PORT}" lalu Stop-Process -Id <PID> -Force`);
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, () => {
  console.log(`Whack-a-Mole realtime berjalan di http://localhost:${PORT}`);
});
