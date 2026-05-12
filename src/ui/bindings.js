import { VIEW } from "../core/constants.js";

export function createBindings({
  getState,
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
  showToast
}) {
  return {
    login: bindLogin,
    menu: bindMenu,
    lobby: bindLobby,
    room: bindRoom,
    game: bindGame,
    leaderboard: bindLeaderboard,
    settings: bindSettings
  };

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

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const username = document.querySelector("#username").value;
      const password = document.querySelector("#password").value;

      if (password) {
        await loginWithEmailPassword({ email: username, password });
        return;
      }

      await login(username, false);
    });

    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const username = document.querySelector("#registerUsername").value;
      const email = document.querySelector("#registerEmail").value;
      const password = document.querySelector("#registerPassword").value;
      await registerWithEmail({ username, email, password });
    });

    document.querySelector("#guestBtn").addEventListener("click", async () => {
      const username = document.querySelector("#username").value || `Guest${Math.floor(Math.random() * 900 + 100)}`;
      await login(username, true);
    });

    document.querySelector("#googleLoginBtn").addEventListener("click", loginWithGoogle);
  }

  function bindMenu() {
    document.querySelector("#backLogin").addEventListener("click", goLogin);

    document.querySelector('[data-view="solo"]').addEventListener("click", () => {
      startSolo();
    });

    document.querySelector('[data-view="multiplayer"]').addEventListener("click", () => {
      connectRealtime();
      send("rooms:list");
      getState().view = VIEW.LOBBY;
      render();
    });

    document.querySelector('[data-view="settings"]').addEventListener("click", () => {
      getState().view = VIEW.SETTINGS;
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
      const state = getState();
      send("room:leave");
      state.room = null;
      state.view = VIEW.LOBBY;
      render();
    });

    document.querySelector("#readyBtn").addEventListener("click", () => {
      const state = getState();
      const me = state.room.players.find((player) => player.id === state.playerId);
      send("room:ready", { ready: !me?.ready });
    });

    document.querySelector("#startBtn").addEventListener("click", () => {
      send("game:start");
    });

    document.querySelector("#copyRoom").addEventListener("click", async () => {
      const state = getState();

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
      const state = getState();
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

  function bindLeaderboard() {
    document.querySelector("#backMenu").addEventListener("click", goMenu);
    document.querySelector("#playAgain").addEventListener("click", () => {
      const state = getState();

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
      const avatarUrl = document.querySelector("#settingsAvatar").value;
      const avatarFile = document.querySelector("#settingsAvatarFile").files?.[0] || null;
      const bio = document.querySelector("#settingsBio").value;
      await saveProfileSettings({ username, avatarUrl, bio, avatarFile });
    });

    document.querySelector("#logout").addEventListener("click", async () => {
      stopGameplay();
      send("room:leave");
      await signOutSupabase();
      setState((state) => ({
        ...state,
        view: VIEW.LOGIN,
        room: null,
        rooms: [],
        leaderboard: [],
        profile: { username: "", avatar: "", bio: "", guest: true, totalScore: 0 }
      }));
      render();
    });

    document.querySelector("#contactCs").addEventListener("click", () => {
      showToast("CS: support@whackrush.local");
    });
  }

  function setupHammerCursor() {
    const arena = document.querySelector("#arena");
    const hammer = document.querySelector("#hammerCursor");
    if (!arena || !hammer) return;

    const moveHammer = (event) => {
      const state = getState();
      const rect = arena.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (state.gameplay && Date.now() < state.gameplay.slowCursorUntil) {
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
}
