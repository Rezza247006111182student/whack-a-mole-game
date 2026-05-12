import { hasSupabaseConfig } from "../core/config.js";
import { escapeAttribute, escapeHtml } from "../core/utils.js";

export function createTemplates({ getState, appConfig }) {
  return {
    login: () => loginTemplate(appConfig),
    menu: () => menuTemplate(getState()),
    lobby: () => lobbyTemplate(getState(), appConfig),
    room: () => roomTemplate(getState()),
    game: () => gameTemplate(getState()),
    leaderboard: () => leaderboardTemplate(getState()),
    settings: () => settingsTemplate(getState()),
    empty: emptyScreen,
  };
}

function loginTemplate(appConfig) {
  const supabaseReady = hasSupabaseConfig(appConfig);

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
              <span><i class="fa-solid fa-user"></i> Username / Email</span>
              <input id="username" name="username" maxlength="80" autocomplete="username" placeholder="FarmerMole atau nama@email.com" required>
            </label>
            <label class="field">
              <span><i class="fa-solid fa-lock"></i> Password</span>
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Kosongkan untuk mode prototype">
            </label>
            <div class="actions">
              <button class="button" type="submit"><i class="fa-solid fa-door-open"></i> Masuk</button>
              <button class="button secondary" id="guestBtn" type="button"><i class="fa-solid fa-user"></i> Guest</button>
            </div>
            <div class="auth-divider"><span>atau</span></div>
            <button class="button google" id="googleLoginBtn" type="button" ${supabaseReady ? "" : "disabled"}>
              <i class="fa-brands fa-google"></i>
              Login dengan Google
            </button>
            <p class="muted">${supabaseReady ? "Google OAuth memakai Supabase Auth." : "Supabase env belum lengkap."}</p>
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
            <p class="muted">Register memakai Supabase Auth. Jika email confirmation aktif, cek email sebelum login.</p>
          </form>
        </div>
      </section>
    </main>
  `;
}

function menuTemplate(state) {
  return `
    <main class="screen farm-menu">
      <header class="menu-topbar farm-menu-topbar">
        <div>
          <span class="eyebrow farm-eyebrow"><i class="fa-solid fa-seedling"></i> Farm village arcade</span>
          <h2>Menu Utama</h2>
          <p class="muted">Pilih jalur bermain, panen poin, lalu rebut papan skor kebun.</p>
        </div>
        <div class="actions menu-actions">
          ${profileChip(state.profile)}
          <button class="button menu-back-login" id="backLogin" type="button">
            <span class="back-glyph" aria-hidden="true">&lt;</span>
            Kembali ke Login
          </button>
        </div>
      </header>

      <section class="farm-menu-hero" aria-label="Ringkasan permainan">
        <div class="farm-menu-hero-copy">
          <span class="tag warn">Whack Rush Farm</span>
          <h1>Siap panen skor?</h1>
          <p>Masuk ke arena, pukul mole yang muncul, hindari jebakan, dan manfaatkan efek spesial untuk mengejar skor tertinggi.</p>
        </div>
        <div class="farm-menu-preview" aria-hidden="true">
          ${authPreviewHole("mole-one")}
          ${authPreviewHole("mole-two")}
          ${authPreviewHole("mole-three")}
        </div>
      </section>

      <section class="menu-grid farm-menu-grid">
        <button class="panel mode-card" data-view="solo">
          <span class="mode-icon"><i class="fa-solid fa-hammer"></i></span>
          <span>
            <h2>Solo Match</h2>
            <p>Main offline selama satu menit dan pecahkan skor pribadi.</p>
          </span>
          <span class="tag warn">Offline</span>
        </button>
        <button class="panel mode-card" data-view="multiplayer">
          <span class="mode-icon"><i class="fa-solid fa-people-group"></i></span>
          <span>
            <h2>Multiplayer</h2>
            <p>Lihat room, buat room baru, atau masuk memakai kode room.</p>
          </span>
          <span class="tag">WebSocket</span>
        </button>
        <button class="panel mode-card" data-view="settings">
          <span class="mode-icon"><i class="fa-solid fa-gear"></i></span>
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

function lobbyTemplate(state, appConfig) {
  const multiplayerStatus = getMultiplayerStatusText(state, appConfig);
  const rows = state.rooms.length
    ? state.rooms
        .map(
          (room) => `
      <div class="room-row">
        <div>
          <strong class="room-code">${room.code}</strong>
          <p class="muted">Host ${escapeHtml(room.host)} &middot; ${room.players}/${room.maxPlayers} pemain</p>
        </div>
        <button class="button" data-join="${room.code}" ${state.connected ? "" : "disabled"}>Masuk</button>
      </div>
    `,
        )
        .join("")
    : `<div class="empty-state">Belum ada room aktif. Buat room dulu untuk mulai multiplayer.</div>`;

  return `
    <main class="screen farm-menu farm-lobby">
      <header class="menu-topbar farm-menu-topbar farm-lobby-topbar">
        <div>
          <span class="eyebrow farm-eyebrow"><i class="fa-solid fa-people-group"></i> Multiplayer farm room</span>
          <h2>Room Tersedia</h2>
          <p class="muted">Buat room baru atau masuk ke kebun teman lewat kode room.</p>
        </div>
        <button class="button menu-back-login" id="backMenu" type="button">
          <span class="back-glyph" aria-hidden="true">&lt;</span>
          Menu Utama
        </button>
      </header>

      <section class="split farm-lobby-layout">
        <div class="panel padded stack farm-lobby-board">
          <h3>Buat atau Join</h3>
          <button class="button" id="createRoom" ${state.connected ? "" : "disabled"}>Buat Room</button>
          <form class="form-stack" id="joinForm">
            <label class="field">
              <span>Kode Room</span>
              <input id="roomCode" maxlength="6" placeholder="ABC123">
            </label>
            <button class="button secondary" ${state.connected ? "" : "disabled"}>Join dengan Kode</button>
          </form>
          <p class="muted">${multiplayerStatus}</p>
        </div>
        <div class="room-list farm-room-list">${rows}</div>
      </section>
    </main>
  `;
}

function roomTemplate(state) {
  const room = state.room;
  if (!room) return emptyScreen("Room belum dipilih.");

  const me = room.players.find((player) => player.id === state.playerId);
  const isHost = room.hostId === state.playerId;
  const allReady =
    room.players.length > 0 && room.players.every((player) => player.ready);

  return `
    <main class="screen farm-menu farm-room">
      <header class="room-header farm-menu-topbar farm-room-topbar">
        <div>
          <span class="eyebrow farm-eyebrow"><i class="fa-solid fa-door-open"></i> Room <strong>${room.code}</strong></span>
          <h2>Menunggu Pemain</h2>
          <p class="muted">Host bisa mulai saat semua pemain ready.</p>
        </div>
        <div class="actions">
          <button class="button secondary" id="copyRoom" type="button">Salin Kode</button>
          <button class="button menu-back-login" id="leaveRoom" type="button">
            <span class="back-glyph" aria-hidden="true">&lt;</span>
            Keluar
          </button>
        </div>
      </header>

      <section class="split farm-room-layout">
        <div class="panel padded stack farm-room-board">
          <h3>Status Room</h3>
          <button class="button" id="readyBtn">${me?.ready ? "Batalkan Ready" : "Ready"}</button>
          <button class="button secondary" id="startBtn" ${isHost && allReady ? "" : "disabled"}>Mulai Game</button>
          <p class="muted">${isHost ? "Kamu adalah host." : "Tunggu host memulai permainan."}</p>
        </div>
        <div class="stack farm-player-list">
          ${room.players
            .map(
              (player) => `
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
          `,
            )
            .join("")}
        </div>
      </section>
    </main>
  `;
}

function gameTemplate(state) {
  const gameplay = state.gameplay;
  const isSolo = state.mode === "solo";
  const players = isSolo ? state.soloPlayers : state.room?.players || [];
  const me =
    players.find((player) => player.id === state.playerId) || players[0];
  const remaining = Math.max(
    0,
    Math.ceil(((gameplay?.endsAt || Date.now()) - Date.now()) / 1000),
  );
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
          <div class="hammer-cursor" id="hammerCursor" aria-hidden="true"></div>
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
              ${players
                .map(
                  (player) => `
                <div class="player-row">
                  <div class="player-name">${avatarTemplate(player)}<strong>${escapeHtml(player.username)}</strong></div>
                  <span class="tag dark">${escapeHtml(player.effect || "Normal")}</span>
                </div>
              `,
                )
                .join("")}
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

function leaderboardTemplate(state) {
  const leaderboard =
    state.mode === "solo"
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
          ${
            leaderboard
              .map(
                (player, index) => `
            <div class="leader-row">
              <div class="player-name">
                <span class="tag ${index === 0 ? "warn" : "dark"}">#${index + 1}</span>
                ${avatarTemplate(player)}
                <strong>${escapeHtml(player.username)}</strong>
              </div>
              <span class="score-number">${player.score} pts</span>
            </div>
          `,
              )
              .join("") ||
            `<div class="empty-state">Belum ada hasil permainan.</div>`
          }
        </div>
      </section>
    </main>
  `;
}

function settingsTemplate(state) {
  return `
    <main class="screen settings-page">
      <header class="settings-hero">
        <div>
          <span class="eyebrow settings-eyebrow"><i class="fa-solid fa-seedling"></i> Farm profile board</span>
          <h2>Profil Kebun</h2>
          <p class="muted">Atur identitas pemain, avatar, dan catatan singkat sebelum masuk ke arena.</p>
        </div>
        <button class="button ghost settings-back" id="backMenu"><i class="fa-solid fa-arrow-left"></i> Kembali</button>
      </header>

      <section class="settings-grid">
        <aside class="settings-card settings-profile-card">
          <div class="settings-avatar-large">
            ${largeAvatarTemplate(state.profile)}
          </div>
          <span class="settings-status-pill"><i class="fa-solid ${state.profile.guest ? "fa-user" : "fa-leaf"}"></i> ${state.profile.guest ? "Guest Farmer" : "Farm Player"}</span>
          <h3>${escapeHtml(state.profile.username || "Guest")}</h3>
          <p class="settings-bio-preview">${escapeHtml(state.profile.bio || "Belum ada bio. Tulis pesan singkat agar profil kebunmu terasa hidup.")}</p>
          <div class="settings-harvest-row">
            <span><i class="fa-solid fa-trophy"></i><strong>${Number(state.profile.totalScore || 0)}</strong><small>Total score</small></span>
            <span><i class="fa-solid fa-image"></i><strong>Avatar</strong><small>${state.profile.avatar ? "Aktif" : "Default"}</small></span>
          </div>
        </aside>

        <div class="settings-main-column">
          <form class="settings-card settings-form-card form-stack" id="settingsForm">
            <div class="settings-card-heading">
              <span><i class="fa-solid fa-pen-to-square"></i></span>
              <div>
                <h3>Edit Profil</h3>
                <p class="muted">Perubahan akan langsung dipakai di lobby dan room.</p>
              </div>
            </div>
            <label class="field">
              <span><i class="fa-solid fa-user"></i> Username</span>
              <input id="settingsUsername" maxlength="20" value="${escapeAttribute(state.profile.username)}" required>
            </label>
            <label class="field">
              <span><i class="fa-solid fa-image"></i> Foto Profil URL</span>
              <input id="settingsAvatar" value="${escapeAttribute(state.profile.avatar)}" placeholder="https://...">
            </label>
            <label class="field">
              <span><i class="fa-solid fa-upload"></i> Upload Foto Profil</span>
              <input id="settingsAvatarFile" type="file" accept="image/*">
            </label>
            <label class="field">
              <span><i class="fa-solid fa-feather"></i> Bio</span>
              <textarea id="settingsBio" maxlength="120" placeholder="Tulis bio singkat">${escapeHtml(state.profile.bio)}</textarea>
            </label>
            <button class="button settings-save"><i class="fa-solid fa-floppy-disk"></i> Simpan Profil</button>
          </form>

          <aside class="settings-card settings-action-card">
            <div class="settings-card-heading">
              <span><i class="fa-solid fa-toolbox"></i></span>
              <div>
                <h3>Aksi Akun</h3>
                <p class="muted">Bantuan, logout, dan catatan status pemain.</p>
              </div>
            </div>
            <div class="settings-action-row">
              <button class="button secondary" id="contactCs"><i class="fa-solid fa-headset"></i> Hubungi CS</button>
              <button class="button danger" id="logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</button>
            </div>
            <p class="settings-note"><i class="fa-solid fa-circle-info"></i> Guest tidak menyimpan score setelah permainan selesai.</p>
          </aside>
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

function getMultiplayerStatusText(state, appConfig) {
  if (state.connected) return "Koneksi multiplayer aktif.";
  if (appConfig.realtimeMode === "disabled") {
    return "Multiplayer belum aktif di build frontend. Jalankan backend lokal atau siapkan Supabase Realtime.";
  }

  if (appConfig.realtimeMode === "supabase") {
    return "Menyambungkan ke Supabase Realtime...";
  }

  return "Menyambungkan ke server...";
}

function emptyScreen(message) {
  return `
    <main class="screen">
      <div class="empty-state">${escapeHtml(message)}</div>
    </main>
  `;
}

function profileChip(profile) {
  return `
    <div class="profile-chip">
      ${avatarTemplate(profile)}
      <span>
        <strong>${escapeHtml(profile.username || "Guest")}</strong>
        <p class="muted">${profile.guest ? "Guest" : "Player"}</p>
      </span>
    </div>
  `;
}

export function avatarTemplate(profile) {
  if (profile.avatar) {
    return `<span class="avatar"><img src="${escapeAttribute(profile.avatar)}" alt=""></span>`;
  }

  const initial =
    (profile.username || "P").trim().charAt(0).toUpperCase() || "P";
  return `<span class="avatar-fallback">${escapeHtml(initial)}</span>`;
}

function largeAvatarTemplate(profile) {
  if (profile.avatar) {
    return `<span class="large-avatar"><img src="${escapeAttribute(profile.avatar)}" alt=""></span>`;
  }

  const initial =
    (profile.username || "P").trim().charAt(0).toUpperCase() || "P";
  return `<span class="large-avatar fallback">${escapeHtml(initial)}</span>`;
}

export function scoreRows(players) {
  return [...players]
    .sort((a, b) => b.score - a.score)
    .map(
      (player) => `
      <div class="player-row">
        <div class="player-name">${avatarTemplate(player)}<strong>${escapeHtml(player.username)}</strong></div>
        <span class="score-number">${player.score}</span>
      </div>
    `,
    )
    .join("");
}
