import "./styles.css";
import { MENU_BGM_SRC, MENU_BGM_VOLUME, VIEW } from "./core/constants.js";
import {
  getAuthRedirectUrl,
  getWebSocketUrl,
  resolveAppConfig,
} from "./core/config.js";
import { cleanUsername, isUsernameAllowed } from "./core/utils.js";
import { createGameplayController } from "./game/gameplayController.js";
import { createRealtimeClient } from "./services/realtimeClient.js";
import { createSupabaseAuthService } from "./services/supabaseAuth.js";
import { moderateUsername } from "./services/usernameModeration.js";
import { createBindings } from "./ui/bindings.js";
import { createTemplates } from "./ui/templates.js";

const app = document.querySelector("#app");

const appConfig = resolveAppConfig();
const templates = createTemplates({
  getState: () => state,
  appConfig,
});

let state = {
  view: VIEW.LOGIN,
  connected: false,
  playerId: getOrCreatePlayerId(),
  profile: {
    username: "",
    avatar: "",
    bio: "",
    guest: true,
    totalScore: 0,
  },
  rooms: [],
  room: null,
  mode: "solo",
  soloPlayers: [],
  lastError: "",
  leaderboard: [],
  gameplay: null,
};

let renderQueued = false;
let menuBgm = null;
let menuBgmUnlocked = false;

const gameplay = createGameplayController({
  app,
  getState: () => state,
  render,
  send,
  pauseMenuBgm,
  showToast,
  onFinalScore: saveFinalScore,
});
const { startSolo, openGame, stopGameplay, drawMoles, updateGameHud } =
  gameplay;

const bindings = createBindings({
  getState: () => state,
  setState,
  render,
  goLogin,
  goMenu,
  startSolo,
  connectRealtime,
  send,
  sendProfile,
  stopGameplay,
  login,
  loginWithGoogle,
  loginWithEmailPassword,
  registerWithEmail,
  saveProfileSettings,
  signOutSupabase,
  showToast,
});

const authService = createSupabaseAuthService(appConfig, {
  onSessionError: (error) => {
    console.warn("Supabase session error:", error.message);
  },
  onSession: applySupabaseSession,
  onReady: render,
  onSetupError: (error) => {
    console.error("Supabase gagal dimuat:", error);
    showToast("Supabase belum bisa dimuat. Cek koneksi internet atau env.");
  },
});

const realtimeClient = createRealtimeClient({
  mode: appConfig.realtimeMode,
  getUrl: () => getWebSocketUrl(appConfig),
  supabaseConfig: {
    url: appConfig.supabaseUrl,
    anonKey: appConfig.supabaseAnonKey,
    lobbyChannel: "lobby",
  },
  playerId: state.playerId,
  getProfile: () => state.profile,
  onDisabled: () => {
    state.connected = false;
    render();
  },
  onOpen: () => {
    state.connected = true;
    render();
  },
  onClose: ({ intentional } = {}) => {
    state.connected = false;
    if (!intentional) {
      showToast("Koneksi multiplayer terputus. Mencoba sambung ulang...");
    }
    render();
  },
  onMessage: handleServerMessage,
});

authService.init();
setupMenuBgmUnlock();
render();

function handleServerMessage(message) {
  const { type, payload } = message;

  if (type === "connected") {
    state.playerId = payload.playerId;
    return;
  }

  if (type === "profile:updated") {
    state.profile = payload.profile;
    return;
  }

  if (type === "rooms:list") {
    state.rooms = payload.rooms;
    scheduleRender();
    return;
  }

  if (type === "room:update") {
    state.room = payload.room;
    state.leaderboard = payload.room.leaderboard || [];

    if (payload.room.status === "ended") {
      stopGameplay();
      state.view = VIEW.LEADERBOARD;
      scheduleRender();
      return;
    }

    if (payload.room.status === "waiting" && state.view !== VIEW.ROOM) {
      state.view = VIEW.ROOM;
    }

    if (payload.room.status === "playing" && state.view !== VIEW.GAME) {
      openGame("multiplayer");
      return;
    }

    if (payload.room.status === "playing" && state.view === VIEW.GAME) {
      updateGameHud();
      return;
    }

    scheduleRender();
    return;
  }

  if (type === "game:started") {
    state.room = payload.room;
    if (state.view !== VIEW.GAME || !state.gameplay) {
      openGame("multiplayer");
      return;
    }

    state.gameplay.endsAt = payload.room.endsAt || state.gameplay.endsAt;
    updateGameHud();
    return;
  }

  if (type === "game:ended") {
    state.leaderboard = payload.leaderboard;
    const myRank =
      state.leaderboard.findIndex((p) => p.id === state.playerId) + 1;
    const myResult = state.leaderboard.find(
      (player) => player.id === state.playerId,
    );

    if (myRank > 0 && myRank <= 3) {
      const victorySfx = new Audio(
        "asset/music/Super Mario Bros. Music - Level Complete - BlittleMcNilsen.mp3",
      );
      victorySfx
        .play()
        .catch((err) => console.warn("Audio play blocked:", err));
    } else if (myRank >= 4) {
      const gameOverSfx = new Audio(
        "asset/music/SUPER MARIO - game over - sound effect - Super Mario Broz..mp3",
      );
      gameOverSfx
        .play()
        .catch((err) => console.warn("Audio play blocked:", err));
    }

    saveFinalScore(myResult?.score || 0);
    stopGameplay();
    state.view = VIEW.LEADERBOARD;
    render();
    return;
  }

  if (type === "error") {
    state.lastError = payload.message;
    showToast(payload.message);
  }
}

function render() {
  renderQueued = false;
  app.className =
    state.view === VIEW.LOGIN
      ? "app-shell auth-shell"
      : state.view === VIEW.SETTINGS
        ? "app-shell settings-shell"
        : [VIEW.MENU, VIEW.LOBBY, VIEW.ROOM].includes(state.view)
          ? "app-shell menu-shell"
          : "app-shell";
  syncMenuBgm();

  if (state.view === VIEW.LOGIN) {
    app.innerHTML = templates.login();
    bindings.login();
    return;
  }

  if (state.view === VIEW.MENU) {
    app.innerHTML = templates.menu();
    bindings.menu();
    return;
  }

  if (state.view === VIEW.LOBBY) {
    app.innerHTML = templates.lobby();
    bindings.lobby();
    return;
  }

  if (state.view === VIEW.ROOM) {
    app.innerHTML = templates.room();
    bindings.room();
    return;
  }

  if (state.view === VIEW.GAME) {
    app.innerHTML = templates.game();
    bindings.game();
    drawMoles();
    return;
  }

  if (state.view === VIEW.LEADERBOARD) {
    app.innerHTML = templates.leaderboard();
    bindings.leaderboard();
    return;
  }

  if (state.view === VIEW.SETTINGS) {
    app.innerHTML = templates.settings();
    bindings.settings();
  }
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function setState(nextState) {
  state = typeof nextState === "function" ? nextState(state) : nextState;
}

async function loginWithGoogle() {
  const { error } = await authService.signInWithGoogle(
    getAuthRedirectUrl(appConfig),
  );

  if (error) {
    showToast(error.message || "Login Google gagal.");
  }
}

async function loginWithEmailPassword({ email, password }) {
  if (!email || !email.includes("@")) {
    showToast("Masukkan email untuk login Supabase.");
    return;
  }

  if (!password) {
    showToast("Password belum diisi.");
    return;
  }

  const { error } = await authService.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    showToast(error.message || "Login email gagal.");
    return;
  }

  showToast("Login berhasil.");
}

async function applySupabaseSession(session) {
  if (!session?.user) return;

  const user = session.user;
  const metadata = user.user_metadata || {};
  const fallbackUsername = user.email?.split("@")[0] || "Player";
  const username =
    metadata.username ||
    metadata.user_name ||
    metadata.preferred_username ||
    metadata.full_name ||
    metadata.name ||
    fallbackUsername;
  const profileResult = await authService.getProfile();
  const savedProfile = profileResult.data;
  const candidateUsername = cleanUsername(savedProfile?.username || username);
  const moderation = await moderateUsername(candidateUsername);
  const safeUsername = moderation.allowed ? candidateUsername : "Player";

  if (profileResult.error) {
    console.warn(
      "Gagal mengambil profil Supabase:",
      profileResult.error.message,
    );
  }

  state.profile = {
    ...state.profile,
    username: safeUsername,
    avatar:
      savedProfile?.avatar_url ||
      metadata.avatar_url ||
      metadata.picture ||
      state.profile.avatar,
    bio: savedProfile?.bio || state.profile.bio || "",
    guest: false,
    totalScore: Number(
      savedProfile?.total_score || state.profile.totalScore || 0,
    ),
  };

  sendProfile();
  await upsertSupabaseProfile();

  if (state.view === VIEW.LOGIN) {
    state.view = VIEW.MENU;
  }

  render();
}

async function registerWithEmail({ username, email, password }) {
  const allowed = await ensureUsernameAllowed(username);
  if (!allowed) return;

  if (!email || !email.includes("@")) {
    showToast("Email belum valid.");
    return;
  }

  if (!password || password.length < 6) {
    showToast("Password minimal 6 karakter.");
    return;
  }

  const { data, error } = await authService.signUpWithEmail({
    username: username.trim(),
    email: email.trim(),
    password,
    redirectTo: getAuthRedirectUrl(appConfig),
  });

  if (error) {
    showToast(error.message || "Register gagal.");
    return;
  }

  if (data?.session) {
    showToast("Akun berhasil dibuat dan profil tersimpan.");
    return;
  }

  showToast("Akun dibuat. Cek email untuk verifikasi sebelum login.");
}

async function upsertSupabaseProfile() {
  const { error } = await authService.upsertProfile(state.profile);

  if (error) {
    console.warn("Gagal sync profile Supabase:", error.message);
  }
}

async function signOutSupabase() {
  const { error } = await authService.signOut();
  if (error) {
    console.warn("Supabase sign out gagal:", error.message);
  }
}

async function saveProfileSettings({ username, avatarUrl, bio, avatarFile }) {
  const allowed = await ensureUsernameAllowed(username);
  if (!allowed) return;

  let nextAvatar = avatarUrl.trim();

  if (avatarFile) {
    showToast("Mengunggah foto profil...");
    const { data, error } = await authService.uploadAvatar(
      avatarFile,
      state.profile.avatar,
    );
    if (error) {
      showToast(error.message || "Upload foto profil gagal.");
      return;
    }
    nextAvatar = data.publicUrl;
  }

  state.profile = {
    ...state.profile,
    username: username.trim(),
    avatar: nextAvatar,
    bio: bio.trim(),
  };
  sendProfile();
  await upsertSupabaseProfile();
  showToast("Profil tersimpan.");
  render();
}

async function saveFinalScore(score) {
  if (state.profile.guest) return;

  const { data, error } = await authService.addProfileScore(score);
  if (error) {
    console.warn("Gagal menyimpan total score:", error.message);
    return;
  }

  if (data?.totalScore !== undefined) {
    state.profile.totalScore = Number(data.totalScore || 0);
  }
}

async function login(username, guest) {
  const allowed = await ensureUsernameAllowed(username);
  if (!allowed) return;

  state.profile = {
    ...state.profile,
    username: username.trim(),
    guest,
    totalScore: guest ? 0 : state.profile.totalScore,
  };

  sendProfile();
  state.view = VIEW.MENU;
  render();
}

async function ensureUsernameAllowed(username) {
  if (!isUsernameAllowed(username)) {
    showToast("Username tidak pantas. Coba nama lain.");
    return false;
  }

  const result = await moderateUsername(username);
  if (!result.allowed) {
    showToast(result.reason || "Username tidak pantas. Coba nama lain.");
    return false;
  }

  return true;
}

function goMenu() {
  stopGameplay();
  realtimeClient.disconnect();
  state.view = VIEW.MENU;
  render();
}

function goLogin() {
  stopGameplay();
  realtimeClient.disconnect();
  state.view = VIEW.LOGIN;
  render();
}

function setupMenuBgmUnlock() {
  const unlock = () => {
    menuBgmUnlocked = true;
    syncMenuBgm();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("touchstart", unlock);
  };

  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
  window.addEventListener("touchstart", unlock, { once: true });
}

function syncMenuBgm() {
  if (state.view === VIEW.GAME) {
    pauseMenuBgm();
    return;
  }

  playMenuBgm();
}

function getMenuBgm() {
  if (!menuBgm) {
    menuBgm = new Audio(MENU_BGM_SRC);
    menuBgm.loop = true;
    menuBgm.volume = MENU_BGM_VOLUME;
    menuBgm.preload = "auto";
  }

  return menuBgm;
}

function playMenuBgm() {
  if (!menuBgmUnlocked || state.view === VIEW.GAME) return;

  const bgm = getMenuBgm();
  if (!bgm.paused) return;

  bgm.play().catch((error) => {
    console.warn("Menu BGM play blocked:", error);
  });
}

function pauseMenuBgm() {
  if (!menuBgm || menuBgm.paused) return;
  menuBgm.pause();
}

function sendProfile() {
  send("profile:update", state.profile);
}

function connectRealtime() {
  ensurePlayerId();
  realtimeClient.connect();
}

function send(type, payload = {}) {
  realtimeClient.send(type, payload);
}

function showToast(message) {
  document.querySelectorAll(".toast").forEach((toast) => toast.remove());
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

function getOrCreatePlayerId() {
  const existing = localStorage.getItem("playerId");
  if (existing) return existing;

  const generated = `p_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  localStorage.setItem("playerId", generated);
  return generated;
}

function ensurePlayerId() {
  if (state.playerId) return;
  state.playerId = getOrCreatePlayerId();
}
