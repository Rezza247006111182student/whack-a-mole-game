const app = document.querySelector("#app");

const VIEW = {
  LOGIN: "login",
  MENU: "menu",
  LOBBY: "lobby",
  ROOM: "room",
  GAME: "game",
  LEADERBOARD: "leaderboard",
  SETTINGS: "settings"
};

const MOLES = [
  { type: "normal", label: "Mole", points: 10, effect: "Combo +10" },
  { type: "gold", label: "Golden", points: 18, effect: "Bonus emas" },
  { type: "freeze", label: "Freeze", points: 6, effect: "Fokus dingin" },
  { type: "bad", label: "Bomb", points: -8, effect: "Terkena bom" }
];

const MAX_ACTIVE_MOLES = 3;
const MOLE_STAY_MIN_MS = 1500;
const MOLE_STAY_MAX_MS = 2400;

const BAD_WORDS = [
  "anjing",
  "bangsat",
  "babi",
  "kontol",
  "memek",
  "ngentot",
  "tolol",
  "goblok"
];

const appConfig = window.APP_CONFIG || {};

let state = {
  view: VIEW.LOGIN,
  connected: false,
  playerId: null,
  profile: {
    username: "",
    avatar: "",
    bio: "",
    guest: true
  },
  rooms: [],
  room: null,
  mode: "solo",
  soloPlayers: [],
  lastError: "",
  leaderboard: [],
  gameplay: null
};

let socket = null;
let renderQueued = false;
let supabase = null;
let supabaseReadyPromise = null;
let authSession = null;
let authUser = null;

initSupabase();
connectSocket();
render();

async function initSupabase() {
  if (supabaseReadyPromise) return supabaseReadyPromise;

  supabaseReadyPromise = setupSupabase();
  return supabaseReadyPromise;
}

async function setupSupabase() {
  if (!hasSupabaseConfig()) return null;

  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(appConfig.supabaseUrl, appConfig.supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true
      }
    });

    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.warn("Supabase session error:", error.message);
    }

    if (data?.session) {
      await applySupabaseSession(data.session);
    }

    supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        applySupabaseSession(session);
      }

      if (event === "SIGNED_OUT") {
        authSession = null;
        authUser = null;
      }
    });

    render();
    return supabase;
  } catch (error) {
    console.error("Supabase gagal dimuat:", error);
    showToast("Supabase belum bisa dimuat. Cek koneksi internet atau env.");
    return null;
  }
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener("open", () => {
    state.connected = true;
    render();
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    showToast("Koneksi multiplayer terputus. Mencoba sambung ulang...");
    setTimeout(connectSocket, 1200);
    render();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleServerMessage(message);
  });
}

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
    const myRank = state.leaderboard.findIndex(p => p.id === state.playerId) + 1;
    
    if (myRank > 0 && myRank <= 3) {
      const victorySfx = new Audio("asset/music/Super Mario Bros. Music - Level Complete - BlittleMcNilsen.mp3");
      victorySfx.play().catch(err => console.warn("Audio play blocked:", err));
    } else if (myRank >= 4) {
      const gameOverSfx = new Audio("asset/music/SUPER MARIO - game over - sound effect - Super Mario Broz..mp3");
      gameOverSfx.play().catch(err => console.warn("Audio play blocked:", err));
    }
    
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
  app.className = state.view === VIEW.LOGIN ? "app-shell auth-shell" : "app-shell";

  if (state.view === VIEW.LOGIN) {
    app.innerHTML = loginTemplate();
    bindLogin();
    return;
  }

  if (state.view === VIEW.MENU) {
    app.innerHTML = menuTemplate();
    bindMenu();
    return;
  }

  if (state.view === VIEW.LOBBY) {
    app.innerHTML = lobbyTemplate();
    bindLobby();
    return;
  }

  if (state.view === VIEW.ROOM) {
    app.innerHTML = roomTemplate();
    bindRoom();
    return;
  }

  if (state.view === VIEW.GAME) {
    app.innerHTML = gameTemplate();
    bindGame();
    drawMoles();
    return;
  }

  if (state.view === VIEW.LEADERBOARD) {
    app.innerHTML = leaderboardTemplate();
    bindLeaderboard();
    return;
  }

  if (state.view === VIEW.SETTINGS) {
    app.innerHTML = settingsTemplate();
    bindSettings();
  }
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function loginTemplate() {
  return `
    <main class="screen login-layout farm-auth">
      <section class="brand-scene farm-hero">
        <div class="brand-title farm-copy">
          <span class="eyebrow farm-eyebrow"><i class="fa-solid fa-seedling"></i> Farm village arcade</span>
          <h1>Whack Rush Farm</h1>
          <p class="lead">Masuk ke kebun, pilih mode bermain, lalu kejar skor tertinggi di arena yang terasa hangat seperti game pertanian klasik.</p>
        </div>

        <div class="auth-field-preview" aria-hidden="true">
          <span class="auth-game-preview">
            ${authPreviewHole("mole-one")}
            ${authPreviewHole("mole-two")}
            ${authPreviewHole("mole-three")}
          </span>
        </div>

        <div class="farm-feature-strip" aria-label="Fitur utama">
          <div class="farm-feature"><i class="fa-solid fa-people-group"></i><small>Mode</small><strong>Solo & Room</strong></div>
          <div class="farm-feature"><i class="fa-solid fa-clock"></i><small>Musim</small><strong>60 Detik</strong></div>
          <div class="farm-feature"><i class="fa-solid fa-trophy"></i><small>Panen</small><strong>Leaderboard</strong></div>
        </div>
      </section>

      <section class="panel login-panel farm-auth-card" id="authCard">
        <div class="farm-card-topper" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="auth-mode-board" role="tablist" aria-label="Pilih login atau register">
          <button class="auth-tab active" id="loginTab" type="button">
            <i class="fa-solid fa-right-to-bracket"></i>
            <span>Login</span>
          </button>
          <button class="auth-tab" id="registerTab" type="button">
            <i class="fa-solid fa-user-plus"></i>
            <span>Register</span>
          </button>
        </div>

        <div class="auth-heading">
          <h2 id="authTitle">Selamat Datang</h2>
          <p class="muted" id="authSubtitle">Masuk sebagai pemain kebun atau lanjut sebagai guest.</p>
        </div>

        <div class="auth-panel-stage">
          <form class="form-stack auth-form active" id="loginForm">
            <label class="field">
              <span><i class="fa-solid fa-user"></i> Username</span>
              <input id="username" name="username" maxlength="20" autocomplete="username" placeholder="contoh: FarmerMole" required>
            </label>
            <label class="field">
              <span><i class="fa-solid fa-lock"></i> Password</span>
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Prototype: boleh dikosongkan">
            </label>
            <div class="actions">
              <button class="button" type="submit"><i class="fa-solid fa-door-open"></i> Masuk</button>
              <button class="button secondary" id="guestBtn" type="button"><i class="fa-solid fa-user"></i> Guest</button>
            </div>
            <div class="auth-divider"><span>atau</span></div>
            <button class="button google" id="googleLoginBtn" type="button" ${hasSupabaseConfig() ? "" : "disabled"}>
              <i class="fa-brands fa-google"></i>
              Login dengan Google
            </button>
            <p class="muted">${hasSupabaseConfig() ? "Google OAuth memakai Supabase Auth." : "Supabase env belum lengkap."}</p>
          </form>

          <form class="form-stack auth-form" id="registerForm">
            <label class="field">
              <span><i class="fa-solid fa-seedling"></i> Username Petani</span>
              <input id="registerUsername" maxlength="20" autocomplete="username" placeholder="contoh: GreenFarmer" required>
            </label>
            <label class="field">
              <span><i class="fa-solid fa-envelope"></i> Email</span>
              <input id="registerEmail" type="email" autocomplete="email" placeholder="nama@email.com">
            </label>
            <label class="field">
              <span><i class="fa-solid fa-key"></i> Password</span>
              <input id="registerPassword" type="password" autocomplete="new-password" placeholder="Minimal 6 karakter">
            </label>
            <button class="button" type="submit"><i class="fa-solid fa-seedling"></i> Buat Akun</button>
            <p class="muted">Untuk tahap UI, register akan membuat profile pemain lokal. Auth penuh bisa disambungkan ke Supabase Auth berikutnya.</p>
          </form>
        </div>
      </section>
    </main>
  `;
}

function authPreviewHole(moleClass) {
  return `
    <span class="auth-preview-hole">
      <span class="auth-preview-mole ${moleClass}">
        <span class="auth-preview-eye eye-left"></span>
        <span class="auth-preview-eye eye-right"></span>
        <span class="auth-preview-nose"></span>
      </span>
      <span class="auth-preview-dirt"></span>
    </span>
  `;
}

function menuTemplate() {
  return `
    <main class="screen">
      <header class="menu-topbar">
        <div>
          <span class="eyebrow"><span class="logo-mark"></span> Whack Rush Arena</span>
          <h2>Menu Utama</h2>
        </div>
        ${profileChip()}
      </header>

      <section class="menu-grid">
        <button class="panel mode-card" data-view="solo">
          <span class="mode-icon">⚒</span>
          <span>
            <h2>Solo Match</h2>
            <p>Main offline selama satu menit dan pecahkan skor pribadi.</p>
          </span>
          <span class="tag warn">Offline</span>
        </button>
        <button class="panel mode-card" data-view="multiplayer">
          <span class="mode-icon">⌁</span>
          <span>
            <h2>Multiplayer</h2>
            <p>Lihat room, buat room baru, atau masuk memakai kode room.</p>
          </span>
          <span class="tag">WebSocket</span>
        </button>
        <button class="panel mode-card" data-view="settings">
          <span class="mode-icon">☼</span>
          <span>
            <h2>Settings</h2>
            <p>Edit username, foto profil, bio, logout, dan hubungi CS.</p>
          </span>
          <span class="tag dark">Profile</span>
        </button>
      </section>
    </main>
  `;
}

function lobbyTemplate() {
  const rows = state.rooms.length
    ? state.rooms.map((room) => `
      <div class="room-row">
        <div>
          <strong class="room-code">${room.code}</strong>
          <p class="muted">Host ${escapeHtml(room.host)} · ${room.players}/${room.maxPlayers} pemain</p>
        </div>
        <button class="button" data-join="${room.code}">Masuk</button>
      </div>
    `).join("")
    : `<div class="empty-state">Belum ada room aktif. Buat room dulu untuk mulai multiplayer.</div>`;

  return `
    <main class="screen">
      <header class="menu-topbar">
        <div>
          <span class="eyebrow"><span class="logo-mark"></span> Multiplayer Lobby</span>
          <h2>Room Tersedia</h2>
        </div>
        <button class="button ghost" id="backMenu">Kembali</button>
      </header>

      <section class="split">
        <div class="panel padded stack">
          <h3>Buat atau Join</h3>
          <button class="button" id="createRoom" ${state.connected ? "" : "disabled"}>Buat Room</button>
          <form class="form-stack" id="joinForm">
            <label class="field">
              <span>Kode Room</span>
              <input id="roomCode" maxlength="6" placeholder="ABC123">
            </label>
            <button class="button secondary" ${state.connected ? "" : "disabled"}>Join dengan Kode</button>
          </form>
          <p class="muted">${state.connected ? "Koneksi multiplayer aktif." : "Menyambungkan ke server..."}</p>
        </div>
        <div class="room-list">${rows}</div>
      </section>
    </main>
  `;
}

function roomTemplate() {
  const room = state.room;
  if (!room) return emptyScreen("Room belum dipilih.");

  const me = room.players.find((player) => player.id === state.playerId);
  const isHost = room.hostId === state.playerId;
  const allReady = room.players.length > 0 && room.players.every((player) => player.ready);

  return `
    <main class="screen">
      <header class="room-header">
        <div>
          <span class="eyebrow"><span class="logo-mark"></span> Room <strong>${room.code}</strong></span>
          <h2>Menunggu Pemain</h2>
          <p class="muted">Host bisa mulai saat semua pemain ready.</p>
        </div>
        <div class="actions">
          <button class="button secondary" id="copyRoom">Salin Kode</button>
          <button class="button ghost" id="leaveRoom">Keluar</button>
        </div>
      </header>

      <section class="split">
        <div class="panel padded stack">
          <h3>Status Room</h3>
          <button class="button" id="readyBtn">${me?.ready ? "Batalkan Ready" : "Ready"}</button>
          <button class="button secondary" id="startBtn" ${isHost && allReady ? "" : "disabled"}>Mulai Game</button>
          <p class="muted">${isHost ? "Kamu adalah host." : "Tunggu host memulai permainan."}</p>
        </div>
        <div class="stack">
          ${room.players.map((player) => `
            <div class="player-row">
              <div class="player-name">
                ${avatarTemplate(player)}
                <span>
                  <strong>${escapeHtml(player.username)}</strong>
                  <p class="muted">${player.host ? "Host" : player.guest ? "Guest" : "Player"}</p>
                </span>
              </div>
              <span class="tag ${player.ready ? "" : "dark"}">${player.ready ? "Ready" : "Waiting"}</span>
            </div>
          `).join("")}
        </div>
      </section>
    </main>
  `;
}

function gameTemplate() {
  const gameplay = state.gameplay;
  const isSolo = state.mode === "solo";
  const players = isSolo ? state.soloPlayers : state.room?.players || [];
  const me = players.find((player) => player.id === state.playerId) || players[0];
  const remaining = Math.max(0, Math.ceil(((gameplay?.endsAt || Date.now()) - Date.now()) / 1000));
  const leader = [...players].sort((a, b) => b.score - a.score)[0];

  return `
    <main class="screen">
      <header class="game-header">
        <div>
          <span class="eyebrow"><span class="logo-mark"></span> ${isSolo ? "Solo Match" : `Room ${state.room?.code || ""}`}</span>
          <h2>Whack Arena</h2>
        </div>
        <button class="button danger" id="exitGame" title="Keluar dari permainan">Keluar</button>
      </header>

      <section class="game-layout">
        <div class="arena" id="arena">
          <div class="hud">
            <div class="stat"><small>Waktu</small><strong id="timer">${remaining}s</strong></div>
            <div class="stat"><small>Score</small><strong id="myScore">${me?.score || 0}</strong></div>
            <div class="stat"><small>Status Efek</small><strong id="effect">${escapeHtml(me?.effect || "Normal")}</strong></div>
          </div>
          <div class="board-wrap">
            <div class="mole-board" id="moleBoard" aria-label="Papan whack-a-mole"></div>
          </div>
          <div class="hammer-cursor" id="hammerCursor" aria-hidden="true">
          </div>
        </div>

        <aside class="side-panel">
          <section class="panel padded">
            <h3>Score Real-time</h3>
            <div class="score-list" id="scoreList">
              ${scoreRows(players)}
            </div>
          </section>
          <section class="panel padded">
            <h3>Status Efek</h3>
            <div class="effect-list" id="effectList">
              ${players.map((player) => `
                <div class="player-row">
                  <div class="player-name">${avatarTemplate(player)}<strong>${escapeHtml(player.username)}</strong></div>
                  <span class="tag dark">${escapeHtml(player.effect || "Normal")}</span>
                </div>
              `).join("")}
            </div>
          </section>
          <section class="panel padded">
            <h3>Pemimpin</h3>
            <p class="muted" id="leaderText">${leader ? `${escapeHtml(leader.username)} sedang unggul dengan ${leader.score} poin.` : "Belum ada skor."}</p>
          </section>
        </aside>
      </section>
    </main>
  `;
}

function leaderboardTemplate() {
  const leaderboard = state.mode === "solo"
    ? [...state.soloPlayers].sort((a, b) => b.score - a.score)
    : state.leaderboard;

  return `
    <main class="screen">
      <header class="menu-topbar">
        <div>
          <span class="eyebrow"><span class="logo-mark"></span> Hasil Akhir</span>
          <h2>Leaderboard</h2>
        </div>
        <div class="actions">
          <button class="button secondary" id="playAgain">${state.mode === "solo" ? "Main Lagi" : "Kembali ke Lobby"}</button>
          <button class="button ghost" id="backMenu">Menu Utama</button>
        </div>
      </header>

      <section class="panel padded">
        <div class="leader-list">
          ${leaderboard.map((player, index) => `
            <div class="leader-row">
              <div class="player-name">
                <span class="tag ${index === 0 ? "warn" : "dark"}">#${index + 1}</span>
                ${avatarTemplate(player)}
                <strong>${escapeHtml(player.username)}</strong>
              </div>
              <span class="score-number">${player.score} pts</span>
            </div>
          `).join("") || `<div class="empty-state">Belum ada hasil permainan.</div>`}
        </div>
      </section>
    </main>
  `;
}

function settingsTemplate() {
  return `
    <main class="screen">
      <header class="menu-topbar">
        <div>
          <span class="eyebrow"><span class="logo-mark"></span> Settings</span>
          <h2>Profil</h2>
        </div>
        <button class="button ghost" id="backMenu">Kembali</button>
      </header>

      <section class="settings-grid">
        <form class="panel padded form-stack" id="settingsForm">
          <label class="field">
            <span>Username</span>
            <input id="settingsUsername" maxlength="20" value="${escapeAttribute(state.profile.username)}" required>
          </label>
          <label class="field">
            <span>Foto Profil URL</span>
            <input id="settingsAvatar" value="${escapeAttribute(state.profile.avatar)}" placeholder="https://...">
          </label>
          <label class="field">
            <span>Bio</span>
            <textarea id="settingsBio" maxlength="120" placeholder="Tulis bio singkat">${escapeHtml(state.profile.bio)}</textarea>
          </label>
          <button class="button">Simpan Profil</button>
        </form>
        <aside class="panel padded stack">
          ${profileChip()}
          <button class="button secondary" id="contactCs">Hubungi CS</button>
          <button class="button danger" id="logout">Logout</button>
          <p class="muted">Guest tidak menyimpan skor setelah permainan selesai.</p>
        </aside>
      </section>
    </main>
  `;
}

function emptyScreen(message) {
  return `
    <main class="screen">
      <div class="empty-state">${escapeHtml(message)}</div>
    </main>
  `;
}

function profileChip() {
  return `
    <div class="profile-chip">
      ${avatarTemplate(state.profile)}
      <span>
        <strong>${escapeHtml(state.profile.username || "Guest")}</strong>
        <p class="muted">${state.profile.guest ? "Guest" : "Player"}</p>
      </span>
    </div>
  `;
}

function avatarTemplate(profile) {
  if (profile.avatar) {
    return `<span class="avatar"><img src="${escapeAttribute(profile.avatar)}" alt=""></span>`;
  }

  const initial = (profile.username || "P").trim().charAt(0).toUpperCase() || "P";
  return `<span class="avatar-fallback">${escapeHtml(initial)}</span>`;
}

function scoreRows(players) {
  return [...players]
    .sort((a, b) => b.score - a.score)
    .map((player) => `
      <div class="player-row">
        <div class="player-name">${avatarTemplate(player)}<strong>${escapeHtml(player.username)}</strong></div>
        <span class="score-number">${player.score}</span>
      </div>
    `).join("");
}

function bindLogin() {
  const authCard = document.querySelector("#authCard");
  const loginTab = document.querySelector("#loginTab");
  const registerTab = document.querySelector("#registerTab");
  const loginForm = document.querySelector("#loginForm");
  const registerForm = document.querySelector("#registerForm");
  const authTitle = document.querySelector("#authTitle");
  const authSubtitle = document.querySelector("#authSubtitle");

  const setAuthMode = (mode) => {
    const isRegister = mode === "register";
    authCard.classList.toggle("is-register", isRegister);
    loginTab.classList.toggle("active", !isRegister);
    registerTab.classList.toggle("active", isRegister);
    loginForm.classList.toggle("active", !isRegister);
    registerForm.classList.toggle("active", isRegister);
    authTitle.textContent = isRegister ? "Buat Akun Kebun" : "Selamat Datang";
    authSubtitle.textContent = isRegister
      ? "Siapkan nama petani untuk mulai mengumpulkan skor."
      : "Masuk sebagai pemain kebun atau lanjut sebagai guest.";
  };

  loginTab.addEventListener("click", () => setAuthMode("login"));
  registerTab.addEventListener("click", () => setAuthMode("register"));

  document.querySelector("#loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const username = document.querySelector("#username").value;
    login(username, false);
  });

  registerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const username = document.querySelector("#registerUsername").value;
    login(username, false);
    showToast("Akun prototype dibuat. Integrasi register Supabase bisa ditambahkan setelah schema auth final.");
  });

  document.querySelector("#guestBtn").addEventListener("click", () => {
    const username = document.querySelector("#username").value || `Guest${Math.floor(Math.random() * 900 + 100)}`;
    login(username, true);
  });

  document.querySelector("#googleLoginBtn").addEventListener("click", loginWithGoogle);
}

function bindMenu() {
  document.querySelector('[data-view="solo"]').addEventListener("click", () => {
    startSolo();
  });

  document.querySelector('[data-view="multiplayer"]').addEventListener("click", () => {
    send("rooms:list");
    state.view = VIEW.LOBBY;
    render();
  });

  document.querySelector('[data-view="settings"]').addEventListener("click", () => {
    state.view = VIEW.SETTINGS;
    render();
  });
}

function bindLobby() {
  document.querySelector("#backMenu").addEventListener("click", goMenu);
  document.querySelector("#createRoom").addEventListener("click", () => {
    sendProfile();
    send("room:create");
  });

  document.querySelector("#joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = document.querySelector("#roomCode").value.trim().toUpperCase();
    if (!code) return;
    sendProfile();
    send("room:join", { code });
  });

  document.querySelectorAll("[data-join]").forEach((button) => {
    button.addEventListener("click", () => {
      sendProfile();
      send("room:join", { code: button.dataset.join });
    });
  });
}

function bindRoom() {
  document.querySelector("#leaveRoom").addEventListener("click", () => {
    send("room:leave");
    state.room = null;
    state.view = VIEW.LOBBY;
    render();
  });

  document.querySelector("#readyBtn").addEventListener("click", () => {
    const me = state.room.players.find((player) => player.id === state.playerId);
    send("room:ready", { ready: !me?.ready });
  });

  document.querySelector("#startBtn").addEventListener("click", () => {
    send("game:start");
  });

  document.querySelector("#copyRoom").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.room.code);
      showToast("Kode room disalin.");
    } catch {
      showToast(`Kode room: ${state.room.code}`);
    }
  });
}

function bindGame() {
  setupHammerCursor();

  document.querySelector("#exitGame").addEventListener("click", () => {
    stopGameplay();

    if (state.mode === "multiplayer") {
      send("game:exit");
      state.room = null;
      state.view = VIEW.LOBBY;
    } else {
      state.view = VIEW.MENU;
    }

    render();
  });
}

function setupHammerCursor() {
  const arena = document.querySelector("#arena");
  const hammer = document.querySelector("#hammerCursor");
  if (!arena || !hammer) return;

  const moveHammer = (event) => {
    const rect = arena.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (state.gameplay && Date.now() < state.gameplay.slowCursorUntil) {
      // Apply "slow" effect via transition and a slight offset or just the transition
      hammer.style.transition = "left 0.15s linear, top 0.15s linear";
    } else {
      hammer.style.transition = "none";
    }

    hammer.style.left = `${x}px`;
    hammer.style.top = `${y}px`;
  };

  arena.addEventListener("pointerenter", (event) => {
    moveHammer(event);
    hammer.classList.add("visible");
  });

  arena.addEventListener("pointermove", moveHammer);

  arena.addEventListener("pointerleave", () => {
    hammer.classList.remove("visible", "swing");
  });

  arena.addEventListener("pointerdown", (event) => {
    moveHammer(event);
    hammer.classList.remove("swing");
    void hammer.offsetWidth;
    hammer.classList.add("swing");
  });

  arena.addEventListener("pointerup", () => {
    setTimeout(() => hammer.classList.remove("swing"), 120);
  });
}

function bindLeaderboard() {
  document.querySelector("#backMenu").addEventListener("click", goMenu);
  document.querySelector("#playAgain").addEventListener("click", () => {
    if (state.mode === "solo") {
      startSolo();
      return;
    }

    send("room:leave");
    state.room = null;
    state.view = VIEW.LOBBY;
    render();
  });
}

function bindSettings() {
  document.querySelector("#backMenu").addEventListener("click", goMenu);
  document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.querySelector("#settingsUsername").value;
    if (!isUsernameAllowed(username)) {
      showToast("Username tidak pantas. Ganti dulu ya.");
      return;
    }

    state.profile = {
      ...state.profile,
      username: username.trim(),
      avatar: document.querySelector("#settingsAvatar").value.trim(),
      bio: document.querySelector("#settingsBio").value.trim()
    };
    sendProfile();
    await upsertSupabaseProfile();
    showToast("Profil tersimpan.");
    render();
  });

  document.querySelector("#logout").addEventListener("click", async () => {
    stopGameplay();
    send("room:leave");
    await signOutSupabase();
    state = {
      ...state,
      view: VIEW.LOGIN,
      room: null,
      rooms: [],
      leaderboard: [],
      profile: { username: "", avatar: "", bio: "", guest: true }
    };
    render();
  });

  document.querySelector("#contactCs").addEventListener("click", () => {
    showToast("CS: support@whackrush.local");
  });
}

async function loginWithGoogle() {
  const client = await initSupabase();

  if (!client) {
    showToast("Supabase belum siap. Cek VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY.");
    return;
  }

  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: getAuthRedirectUrl()
    }
  });

  if (error) {
    showToast(error.message || "Login Google gagal.");
  }
}

async function applySupabaseSession(session) {
  if (!session?.user) return;

  authSession = session;
  authUser = session.user;

  const metadata = authUser.user_metadata || {};
  const fallbackUsername = authUser.email?.split("@")[0] || "Player";
  const username = metadata.user_name || metadata.preferred_username || metadata.full_name || metadata.name || fallbackUsername;

  state.profile = {
    ...state.profile,
    username: cleanUsername(username),
    avatar: metadata.avatar_url || metadata.picture || state.profile.avatar,
    guest: false
  };

  sendProfile();
  await upsertSupabaseProfile();

  if (state.view === VIEW.LOGIN) {
    state.view = VIEW.MENU;
  }

  render();
}

async function upsertSupabaseProfile() {
  if (!supabase || !authUser || state.profile.guest) return;

  const { error } = await supabase
    .from("profiles")
    .upsert({
      id: authUser.id,
      username: state.profile.username,
      avatar_url: state.profile.avatar,
      bio: state.profile.bio || "",
      updated_at: new Date().toISOString()
    }, {
      onConflict: "id"
    });

  if (error) {
    console.warn("Gagal sync profile Supabase:", error.message);
  }
}

async function signOutSupabase() {
  if (!supabase || !authSession) return;

  const { error } = await supabase.auth.signOut();
  if (error) {
    console.warn("Supabase sign out gagal:", error.message);
  }

  authSession = null;
  authUser = null;
}

function login(username, guest) {
  if (!isUsernameAllowed(username)) {
    showToast("Username tidak pantas. Coba nama lain.");
    return;
  }

  state.profile = {
    ...state.profile,
    username: username.trim(),
    guest
  };

  sendProfile();
  state.view = VIEW.MENU;
  render();
}

function startSolo() {
  const botNames = ["Nara", "Bima", "Saka"];
  state.mode = "solo";
  state.soloPlayers = [
    {
      id: state.playerId || "solo-player",
      username: state.profile.username,
      avatar: state.profile.avatar,
      guest: state.profile.guest,
      score: 0,
      effect: "Normal"
    },
    ...botNames.map((name, index) => ({
      id: `bot-${index}`,
      username: name,
      avatar: "",
      guest: false,
      score: Math.floor(Math.random() * 12),
      effect: "Bot aktif"
    }))
  ];
  state.leaderboard = [];
  openGame("solo");
}

function openGame(mode) {
  stopGameplay();
  state.mode = mode;
  state.gameplay = {
    holes: Array.from({ length: 9 }, () => null),
    endsAt: mode === "solo" ? Date.now() + 60_000 : state.room?.endsAt || Date.now() + 60_000,
    nextSpawn: null,
    timer: null,
    botTimer: null,
    renderTimer: null,
    // Special Effects State
    redMoleTimeout: null,
    totalBonusTime: 0,
    doubleScoreUntil: 0,
    slowCursorUntil: 0,
    goldHits: [],
    freezeHits: [],
    audio: null,
    bgm: null
  };

  // Play Gameplay BGM
  state.gameplay.bgm = new Audio("asset/music/Sonic The Hedgehog OST - Marble Zone - Hanternos.mp3");
  state.gameplay.bgm.loop = true;
  state.gameplay.bgm.volume = 0.4;
  state.gameplay.bgm.play().catch(err => console.warn("BGM play blocked:", err));

  state.view = VIEW.GAME;
  render();
  startGameplayLoop();
}

function triggerFlashbang() {
  const overlay = document.createElement("div");
  overlay.className = "flashbang-overlay";
  app.appendChild(overlay);
  
  showToast("FLASHBANG! Mata silau!");

  // Play Flashbang Sound
  const flashSfx = new Audio("asset/music/Flashbang Sound Effect - FX Studio Sounds.mp3");
  flashSfx.volume = 1.0;
  flashSfx.play().catch(err => console.warn("Audio play blocked by browser:", err));
  
  setTimeout(() => {
    overlay.remove();
  }, 2500);
}

function triggerSnowfall() {
  const arena = document.querySelector("#arena");
  if (!arena) return;

  const snowContainer = document.createElement("div");
  snowContainer.className = "snow-container";
  arena.appendChild(snowContainer);

  for (let i = 0; i < 100; i++) {
    const flake = document.createElement("div");
    flake.className = "snowflake";
    flake.style.left = `${Math.random() * 100}%`;
    flake.style.width = `${Math.random() * 7 + 5}px`;
    flake.style.height = flake.style.width;
    flake.style.opacity = Math.random() * 0.7 + 0.3;
    flake.style.animationDelay = `${Math.random() * 5}s`;
    flake.style.animationDuration = `${Math.random() * 3 + 4}s`;
    snowContainer.appendChild(flake);
  }

  showToast("SNOWFALL! Dingin sekali!");

  // Play Music & Handle BGM Overlap
  if (state.gameplay) {
    if (state.gameplay.audio) {
      state.gameplay.audio.pause();
    }
    
    // Pause main BGM during snowfall
    if (state.gameplay.bgm) {
      state.gameplay.bgm.pause();
    }

    state.gameplay.audio = new Audio("asset/music/Frozen - Let It Go (Piano Version) - Patrik Pietschmann.mp3");
    state.gameplay.audio.volume = 0.5;
    state.gameplay.audio.currentTime = 188; // Start at 3:08
    state.gameplay.audio.play().catch(err => console.warn("Audio play blocked by browser:", err));
  }

  setTimeout(() => {
    snowContainer.remove();
    if (state.gameplay?.audio) {
      // Fade out effect
      const fadeInterval = setInterval(() => {
        if (state.gameplay?.audio && state.gameplay.audio.volume > 0.05) {
          state.gameplay.audio.volume -= 0.05;
        } else {
          clearInterval(fadeInterval);
          if (state.gameplay?.audio) {
            state.gameplay.audio.pause();
            state.gameplay.audio = null;
            
            // Resume BGM after snowfall if game is still active
            if (state.gameplay && state.gameplay.bgm) {
              state.gameplay.bgm.play().catch(err => console.warn("BGM resume blocked:", err));
            }
          }
        }
      }, 100);
    }
  }, 10000);
}

function startGameplayLoop() {
  if (!state.gameplay) return;

  spawnMoles(randomInt(1, 3));
  state.gameplay.nextSpawn = setInterval(() => {
    const activeCount = countActiveMoles();
    if (activeCount < MAX_ACTIVE_MOLES) {
      spawnMoles(randomInt(1, MAX_ACTIVE_MOLES - activeCount));
    }
  }, 1150);
  state.gameplay.renderTimer = setInterval(updateGameHud, 220);

  if (state.mode === "solo") {
    state.gameplay.botTimer = setInterval(updateSoloBots, 900);
  }

  state.gameplay.timer = setTimeout(finishLocalGame, Math.max(0, state.gameplay.endsAt - Date.now()));
}

function stopGameplay() {
  if (!state.gameplay) return;
  for (const mole of state.gameplay.holes) {
    if (mole?.timeoutId) {
      clearTimeout(mole.timeoutId);
    }
    if (mole?.removeTimeoutId) {
      clearTimeout(mole.removeTimeoutId);
    }
  }
  clearInterval(state.gameplay.nextSpawn);
  clearInterval(state.gameplay.botTimer);
  clearInterval(state.gameplay.renderTimer);
  clearTimeout(state.gameplay.timer);
  if (state.gameplay.redMoleTimeout) {
    clearTimeout(state.gameplay.redMoleTimeout);
  }
  
  // Stop Effect Audio
  if (state.gameplay.audio) {
    state.gameplay.audio.pause();
    state.gameplay.audio = null;
  }
  
  // Stop BGM
  if (state.gameplay.bgm) {
    state.gameplay.bgm.pause();
    state.gameplay.bgm = null;
  }

  state.gameplay = null;
}

function finishLocalGame() {
  if (state.mode === "solo") {
    state.leaderboard = [...state.soloPlayers].sort((a, b) => b.score - a.score);
    
    const myRank = state.leaderboard.findIndex(p => p.id === (state.playerId || "solo-player")) + 1;
    if (myRank > 0 && myRank <= 3) {
      const victorySfx = new Audio("asset/music/Super Mario Bros. Music - Level Complete - BlittleMcNilsen.mp3");
      victorySfx.play().catch(err => console.warn("Audio play blocked:", err));
    } else if (myRank >= 4) {
      const gameOverSfx = new Audio("asset/music/SUPER MARIO - game over - sound effect - Super Mario Broz..mp3");
      gameOverSfx.play().catch(err => console.warn("Audio play blocked:", err));
    }

    stopGameplay();
    state.view = VIEW.LEADERBOARD;
    render();
  }
}

function spawnMoles(count = 1, excludedIndexes = []) {
  if (!state.gameplay || state.view !== VIEW.GAME) return;
  if (Date.now() >= state.gameplay.endsAt) return;

  const excluded = new Set(excludedIndexes);
  const activeCount = countActiveMoles();
  const availableIndexes = getAvailableHoleIndexes(excluded);
  const spawnCount = Math.min(count, MAX_ACTIVE_MOLES - activeCount, availableIndexes.length);

  for (let i = 0; i < spawnCount; i += 1) {
    const pickIndex = randomInt(0, availableIndexes.length - 1);
    const holeIndex = availableIndexes.splice(pickIndex, 1)[0];
    const mole = {
      ...weightedMole(),
      id: `${Date.now()}-${Math.random()}`,
      phase: "active",
      timeoutId: null,
      removeTimeoutId: null
    };

    mole.timeoutId = setTimeout(() => {
      dismissMole(holeIndex, mole.id, "leaving");
    }, randomInt(MOLE_STAY_MIN_MS, MOLE_STAY_MAX_MS));

    state.gameplay.holes[holeIndex] = mole;
  }

  drawMoles();
}

function getAvailableHoleIndexes(excluded = new Set()) {
  if (!state.gameplay) return [];

  return state.gameplay.holes
    .map((mole, index) => ({ mole, index }))
    .filter(({ mole, index }) => !mole && !excluded.has(index))
    .map(({ index }) => index);
}

function dismissMole(holeIndex, expectedId = null, phase = "leaving") {
  if (!state.gameplay) return;

  const mole = state.gameplay.holes[holeIndex];
  if (!mole) return;
  if (expectedId && mole.id !== expectedId) return;
  if (mole.phase === "hit" || mole.phase === "leaving") return;

  clearTimeout(mole.timeoutId);
  mole.phase = phase;
  mole.removeTimeoutId = setTimeout(() => {
    removeMole(holeIndex, mole.id);
  }, phase === "hit" ? 210 : 240);
  drawMoles();
}

function countActiveMoles() {
  return state.gameplay?.holes.filter((mole) => mole?.phase === "active").length || 0;
}

function removeMole(holeIndex, expectedId = null) {
  if (!state.gameplay) return;

  const mole = state.gameplay.holes[holeIndex];
  if (!mole) return;
  if (expectedId && mole.id !== expectedId) return;

  clearTimeout(mole.timeoutId);
  clearTimeout(mole.removeTimeoutId);
  state.gameplay.holes[holeIndex] = null;
  drawMoles();
}

function drawMoles() {
  const board = document.querySelector("#moleBoard");
  if (!board || !state.gameplay) return;

  ensureBoardHoles(board);
  syncMoleBoard(board);
}

function ensureBoardHoles(board) {
  if (board.children.length === state.gameplay.holes.length) return;

  board.innerHTML = state.gameplay.holes.map((_, index) => `
    <button class="hole" type="button" data-hole="${index}" aria-label="Lubang kosong"></button>
  `).join("");

  board.querySelectorAll(".hole").forEach((hole) => {
    hole.addEventListener("click", hitHole);
  });
}

function syncMoleBoard(board) {
  state.gameplay.holes.forEach((mole, index) => {
    const hole = board.children[index];
    if (!hole) return;

    if (!mole) {
      if (hole.dataset.moleId) {
        hole.dataset.moleId = "";
        hole.innerHTML = "";
      }
      if (hole.className !== "hole") {
        hole.className = "hole";
      }
      hole.setAttribute("aria-label", "Lubang kosong");
      return;
    }

    const phaseClass = mole.phase === "hit"
      ? "is-hit"
      : mole.phase === "leaving"
        ? "is-leaving"
        : "up";
    const nextClass = `hole has-mole ${phaseClass}`;

    if (hole.dataset.moleId !== mole.id) {
      hole.dataset.moleId = mole.id;
      hole.innerHTML = `<span class="mole ${mole.type}"><span class="mole-face"></span></span>`;
    }

    if (hole.className !== nextClass) {
      hole.className = nextClass;
    }

    hole.setAttribute("aria-label", `Pukul ${mole.label}`);
  });
}

function hitHole(event) {
  const hole = event.currentTarget;
  const index = Number(hole.dataset.hole);
  const mole = state.gameplay?.holes[index];
  if (!mole || mole.phase !== "active") return;

  // Play Hammer Hit Sound
  const hitSfx = new Audio("asset/music/Sword_Armor_Tool Break (Minecraft Sound) - Sound Effect for editing - Sound Library.mp3");
  hitSfx.volume = 0.6;
  hitSfx.play().catch(err => console.warn("Hit sound blocked:", err));

  const points = applyMoleEffect(mole.type, mole.points);
  popScore(hole, points);
  dismissMole(index, mole.id, "hit");
  setTimeout(() => spawnMoles(1, [index]), 150);
  updateGameHud();
}

function applyMoleEffect(type, basePoints) {
  if (!state.gameplay) return basePoints;

  let points = basePoints;

  // 2. Gold Mole Buff: Double score
  if (Date.now() < state.gameplay.doubleScoreUntil) {
    points *= 2;
  }

  if (type === "gold") {
    state.gameplay.doubleScoreUntil = Date.now() + 5000;
    showToast("DOUBLE SCORE! (5 detik)");

    // Flashbang tracking
    state.gameplay.goldHits.push(Date.now());
    // Filter hits within last 5 seconds
    state.gameplay.goldHits = state.gameplay.goldHits.filter(t => Date.now() - t < 5000);
    
    if (state.gameplay.goldHits.length >= 3) {
      triggerFlashbang();
      state.gameplay.goldHits = [];
    }
  }

  // 3. Freeze Mole Buff: Slow cursor
  if (type === "freeze") {
    state.gameplay.slowCursorUntil = Date.now() + 2000;
    showToast("CURSOR SLOWED! (2 detik)");

    // Snowfall tracking
    state.gameplay.freezeHits.push(Date.now());
    // Filter hits within last 10 seconds
    state.gameplay.freezeHits = state.gameplay.freezeHits.filter(t => Date.now() - t < 10000);
    
    if (state.gameplay.freezeHits.length >= 3) {
      triggerSnowfall();
      state.gameplay.freezeHits = [];
    }
  }

  // 1. Red Mole (Bad) Effect
  if (type === "bad") {
    if (state.gameplay.redMoleTimeout) {
      // Hit 2nd red mole within 3s
      clearTimeout(state.gameplay.redMoleTimeout);
      state.gameplay.redMoleTimeout = null;

      if (state.gameplay.totalBonusTime < 30000) {
        state.gameplay.endsAt += 10000;
        state.gameplay.totalBonusTime += 10000;
        showToast("COMBO MERAH! +10 detik");
        
        // Update game timer
        clearTimeout(state.gameplay.timer);
        state.gameplay.timer = setTimeout(finishLocalGame, Math.max(0, state.gameplay.endsAt - Date.now()));
      } else {
        showToast("Jatah buff dari tikus merah sudah habis");
      }
    } else {
      // Hit 1st red mole
      showToast("WASPADA! Pukul lagi dalam 3 detik atau -10 detik");
      state.gameplay.redMoleTimeout = setTimeout(() => {
        state.gameplay.redMoleTimeout = null;
        state.gameplay.endsAt -= 10000;
        showToast("WAKTU BERKURANG -10 detik");
        
        // Update game timer
        clearTimeout(state.gameplay.timer);
        state.gameplay.timer = setTimeout(finishLocalGame, Math.max(0, state.gameplay.endsAt - Date.now()));
      }, 3000);
    }
  }

  addLocalScore(points, MOLES.find(m => m.type === type)?.effect || "Normal");
  return points;
}

function addLocalScore(points, effect) {
  if (state.mode === "multiplayer") {
    send("game:score", { points, effect });
    return;
  }

  const me = state.soloPlayers.find((player) => player.id === (state.playerId || "solo-player")) || state.soloPlayers[0];
  me.score = Math.max(0, me.score + points);
  me.effect = effect;
}

function updateSoloBots() {
  if (!state.gameplay || state.mode !== "solo") return;

  for (const bot of state.soloPlayers.filter((player) => player.id.startsWith("bot-"))) {
    const gain = Math.random() > 0.25 ? Math.floor(Math.random() * 13) : 0;
    bot.score += gain;
    bot.effect = gain > 0 ? "Bot combo" : "Mengintai";
  }
  updateGameHud();
}

function updateGameHud() {
  if (!state.gameplay || state.view !== VIEW.GAME) return;

  const players = state.mode === "solo" ? state.soloPlayers : state.room?.players || [];
  const me = players.find((player) => player.id === state.playerId) || players[0];
  const remaining = Math.max(0, Math.ceil((state.gameplay.endsAt - Date.now()) / 1000));

  const timer = document.querySelector("#timer");
  const score = document.querySelector("#myScore");
  const effect = document.querySelector("#effect");
  const scoreList = document.querySelector("#scoreList");
  const effectList = document.querySelector("#effectList");
  const leaderText = document.querySelector("#leaderText");
  const leader = [...players].sort((a, b) => b.score - a.score)[0];

  if (timer) timer.textContent = `${remaining}s`;
  if (score) score.textContent = me?.score || 0;

  // Active Effects Indicators
  let activeEffects = [];
  const now = Date.now();

  if (state.gameplay.doubleScoreUntil > now) {
    const s = Math.ceil((state.gameplay.doubleScoreUntil - now) / 1000);
    activeEffects.push(`<span class="tag warn"><i class="fa-solid fa-coins" style="margin-right: 4px;"></i> ${s}s</span>`);
  }

  if (state.gameplay.slowCursorUntil > now) {
    const s = Math.ceil((state.gameplay.slowCursorUntil - now) / 1000);
    activeEffects.push(`<span class="tag danger"><i class="fa-solid fa-snowflake" style="margin-right: 4px;"></i> ${s}s</span>`);
  }

  if (state.gameplay.redMoleTimeout) {
    activeEffects.push(`<span class="tag"><i class="fa-solid fa-fire" style="margin-right: 4px;"></i> COMBO!</span>`);
  }

  if (effect) {
    effect.innerHTML = activeEffects.length > 0 ? activeEffects.join(" ") : "Normal";
  }

  if (scoreList) scoreList.innerHTML = scoreRows(players);
  if (effectList) {
    effectList.innerHTML = players.map((player) => `
      <div class="player-row">
        <div class="player-name">${avatarTemplate(player)}<strong>${escapeHtml(player.username)}</strong></div>
        <span class="tag dark">${escapeHtml(player.effect || "Normal")}</span>
      </div>
    `).join("");
  }
  if (leaderText) {
    leaderText.textContent = leader
      ? `${leader.username} sedang unggul dengan ${leader.score} poin.`
      : "Belum ada skor.";
  }
}

function popScore(hole, points) {
  const arena = document.querySelector("#arena");
  if (!arena) return;

  const holeRect = hole.getBoundingClientRect();
  const arenaRect = arena.getBoundingClientRect();
  const label = document.createElement("span");
  label.className = "floating-score";
  label.textContent = points > 0 ? `+${points}` : String(points);
  label.style.left = `${holeRect.left - arenaRect.left + holeRect.width / 2}px`;
  label.style.top = `${holeRect.top - arenaRect.top + 20}px`;
  arena.append(label);
  setTimeout(() => label.remove(), 700);
}

function weightedMole() {
  const roll = Math.random();
  if (roll > 0.88) return MOLES[1];
  if (roll > 0.76) return MOLES[2];
  if (roll > 0.64) return MOLES[3];
  return MOLES[0];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function goMenu() {
  stopGameplay();
  state.view = VIEW.MENU;
  render();
}

function sendProfile() {
  send("profile:update", state.profile);
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, payload }));
}

function hasSupabaseConfig() {
  return Boolean(appConfig.supabaseUrl && appConfig.supabaseAnonKey);
}

function getAuthRedirectUrl() {
  return appConfig.authRedirectUrl || window.location.origin;
}

function cleanUsername(value) {
  const username = String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 20);

  return username || "Player";
}

function isUsernameAllowed(username) {
  const value = username.trim().toLowerCase();
  if (value.length < 2) return false;
  return !BAD_WORDS.some((word) => value.includes(word));
}

function showToast(message) {
  document.querySelectorAll(".toast").forEach((toast) => toast.remove());
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
