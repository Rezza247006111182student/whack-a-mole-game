import {
  MAX_ACTIVE_MOLES,
  MOLES,
  MOLE_STAY_MAX_MS,
  MOLE_STAY_MIN_MS,
  VIEW
} from "../core/constants.js";
import { escapeHtml, randomInt } from "../core/utils.js";
import { avatarTemplate, scoreRows } from "../ui/templates.js";

export function createGameplayController({
  app,
  getState,
  render,
  send,
  pauseMenuBgm,
  showToast,
  onFinalScore
}) {
  return {
    startSolo,
    openGame,
    stopGameplay,
    drawMoles,
    updateGameHud
  };

  function startSolo() {
    const state = getState();
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
    const state = getState();
    stopGameplay();
    pauseMenuBgm();
    state.mode = mode;
    state.gameplay = {
      holes: Array.from({ length: 9 }, () => null),
      endsAt: mode === "solo" ? Date.now() + 60_000 : state.room?.endsAt || Date.now() + 60_000,
      nextSpawn: null,
      timer: null,
      botTimer: null,
      renderTimer: null,
      redMoleTimeout: null,
      totalBonusTime: 0,
      doubleScoreUntil: 0,
      slowCursorUntil: 0,
      goldHits: [],
      freezeHits: [],
      audio: null,
      bgm: null
    };

    state.gameplay.bgm = new Audio("asset/music/Sonic The Hedgehog OST - Marble Zone - Hanternos.mp3");
    state.gameplay.bgm.loop = true;
    state.gameplay.bgm.volume = 0.4;
    state.gameplay.bgm.play().catch((error) => console.warn("BGM play blocked:", error));

    state.view = VIEW.GAME;
    render();
    startGameplayLoop();
  }

  function triggerFlashbang() {
    const overlay = document.createElement("div");
    overlay.className = "flashbang-overlay";
    app.appendChild(overlay);

    showToast("FLASHBANG! Mata silau!");

    const flashSfx = new Audio("asset/music/Flashbang Sound Effect - FX Studio Sounds.mp3");
    flashSfx.volume = 1.0;
    flashSfx.play().catch((error) => console.warn("Audio play blocked by browser:", error));

    setTimeout(() => {
      overlay.remove();
    }, 2500);
  }

  function triggerSnowfall() {
    const state = getState();
    const arena = document.querySelector("#arena");
    if (!arena) return;

    const snowContainer = document.createElement("div");
    snowContainer.className = "snow-container";
    arena.appendChild(snowContainer);

    for (let i = 0; i < 100; i += 1) {
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

    if (state.gameplay) {
      if (state.gameplay.audio) {
        state.gameplay.audio.pause();
      }

      if (state.gameplay.bgm) {
        state.gameplay.bgm.pause();
      }

      state.gameplay.audio = new Audio("asset/music/Frozen - Let It Go (Piano Version) - Patrik Pietschmann.mp3");
      state.gameplay.audio.volume = 0.5;
      state.gameplay.audio.currentTime = 188;
      state.gameplay.audio.play().catch((error) => console.warn("Audio play blocked by browser:", error));
    }

    setTimeout(() => {
      snowContainer.remove();
      if (state.gameplay?.audio) {
        const fadeInterval = setInterval(() => {
          if (state.gameplay?.audio && state.gameplay.audio.volume > 0.05) {
            state.gameplay.audio.volume -= 0.05;
          } else {
            clearInterval(fadeInterval);
            if (state.gameplay?.audio) {
              state.gameplay.audio.pause();
              state.gameplay.audio = null;

              if (state.gameplay?.bgm) {
                state.gameplay.bgm.play().catch((error) => console.warn("BGM resume blocked:", error));
              }
            }
          }
        }, 100);
      }
    }, 10000);
  }

  function startGameplayLoop() {
    const state = getState();
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
    const state = getState();
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

    if (state.gameplay.audio) {
      state.gameplay.audio.pause();
      state.gameplay.audio = null;
    }

    if (state.gameplay.bgm) {
      state.gameplay.bgm.pause();
      state.gameplay.bgm = null;
    }

    state.gameplay = null;
  }

  function finishLocalGame() {
    const state = getState();
    if (state.mode === "solo") {
      state.leaderboard = [...state.soloPlayers].sort((a, b) => b.score - a.score);

      const myRank = state.leaderboard.findIndex((player) => player.id === (state.playerId || "solo-player")) + 1;
      const me = state.leaderboard.find((player) => player.id === (state.playerId || "solo-player"));
      if (myRank > 0 && myRank <= 3) {
        const victorySfx = new Audio("asset/music/Super Mario Bros. Music - Level Complete - BlittleMcNilsen.mp3");
        victorySfx.play().catch((error) => console.warn("Audio play blocked:", error));
      } else if (myRank >= 4) {
        const gameOverSfx = new Audio("asset/music/SUPER MARIO - game over - sound effect - Super Mario Broz..mp3");
        gameOverSfx.play().catch((error) => console.warn("Audio play blocked:", error));
      }

      onFinalScore?.(me?.score || 0);
      stopGameplay();
      state.view = VIEW.LEADERBOARD;
      render();
    }
  }

  function spawnMoles(count = 1, excludedIndexes = []) {
    const state = getState();
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
    const state = getState();
    if (!state.gameplay) return [];

    return state.gameplay.holes
      .map((mole, index) => ({ mole, index }))
      .filter(({ mole, index }) => !mole && !excluded.has(index))
      .map(({ index }) => index);
  }

  function dismissMole(holeIndex, expectedId = null, phase = "leaving") {
    const state = getState();
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
    return getState().gameplay?.holes.filter((mole) => mole?.phase === "active").length || 0;
  }

  function removeMole(holeIndex, expectedId = null) {
    const state = getState();
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
    const state = getState();
    const board = document.querySelector("#moleBoard");
    if (!board || !state.gameplay) return;

    ensureBoardHoles(board);
    syncMoleBoard(board);
  }

  function ensureBoardHoles(board) {
    const state = getState();
    if (board.children.length === state.gameplay.holes.length) return;

    board.innerHTML = state.gameplay.holes.map((_, index) => `
      <button class="hole" type="button" data-hole="${index}" aria-label="Lubang kosong"></button>
    `).join("");

    board.querySelectorAll(".hole").forEach((hole) => {
      hole.addEventListener("click", hitHole);
    });
  }

  function syncMoleBoard(board) {
    const state = getState();

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
    const state = getState();
    const hole = event.currentTarget;
    const index = Number(hole.dataset.hole);
    const mole = state.gameplay?.holes[index];
    if (!mole || mole.phase !== "active") return;

    const hitSfx = new Audio("asset/music/Sword_Armor_Tool Break (Minecraft Sound) - Sound Effect for editing - Sound Library.mp3");
    hitSfx.volume = 0.6;
    hitSfx.play().catch((error) => console.warn("Hit sound blocked:", error));

    const points = applyMoleEffect(mole.type, mole.points);
    popScore(hole, points);
    dismissMole(index, mole.id, "hit");
    setTimeout(() => spawnMoles(1, [index]), 150);
    updateGameHud();
  }

  function applyMoleEffect(type, basePoints) {
    const state = getState();
    if (!state.gameplay) return basePoints;

    let points = basePoints;

    if (Date.now() < state.gameplay.doubleScoreUntil) {
      points *= 2;
    }

    if (type === "gold") {
      state.gameplay.doubleScoreUntil = Date.now() + 5000;
      showToast("DOUBLE SCORE! (5 detik)");

      state.gameplay.goldHits.push(Date.now());
      state.gameplay.goldHits = state.gameplay.goldHits.filter((time) => Date.now() - time < 5000);

      if (state.gameplay.goldHits.length >= 3) {
        triggerFlashbang();
        state.gameplay.goldHits = [];
      }
    }

    if (type === "freeze") {
      state.gameplay.slowCursorUntil = Date.now() + 2000;
      showToast("CURSOR SLOWED! (2 detik)");

      state.gameplay.freezeHits.push(Date.now());
      state.gameplay.freezeHits = state.gameplay.freezeHits.filter((time) => Date.now() - time < 10000);

      if (state.gameplay.freezeHits.length >= 3) {
        triggerSnowfall();
        state.gameplay.freezeHits = [];
      }
    }

    if (type === "bad") {
      if (state.gameplay.redMoleTimeout) {
        clearTimeout(state.gameplay.redMoleTimeout);
        state.gameplay.redMoleTimeout = null;

        if (state.gameplay.totalBonusTime < 30000) {
          state.gameplay.endsAt += 10000;
          state.gameplay.totalBonusTime += 10000;
          showToast("COMBO MERAH! +10 detik");

          clearTimeout(state.gameplay.timer);
          state.gameplay.timer = setTimeout(finishLocalGame, Math.max(0, state.gameplay.endsAt - Date.now()));
        } else {
          showToast("Jatah buff dari tikus merah sudah habis");
        }
      } else {
        showToast("WASPADA! Pukul lagi dalam 3 detik atau -10 detik");
        state.gameplay.redMoleTimeout = setTimeout(() => {
          state.gameplay.redMoleTimeout = null;
          state.gameplay.endsAt -= 10000;
          showToast("WAKTU BERKURANG -10 detik");

          clearTimeout(state.gameplay.timer);
          state.gameplay.timer = setTimeout(finishLocalGame, Math.max(0, state.gameplay.endsAt - Date.now()));
        }, 3000);
      }
    }

    addLocalScore(points, MOLES.find((mole) => mole.type === type)?.effect || "Normal");
    return points;
  }

  function addLocalScore(points, effect) {
    const state = getState();
    const scoreDelta = normalizeScoreDelta(points);

    if (state.mode === "multiplayer") {
      applyOptimisticMultiplayerScore(scoreDelta, effect);
      send("game:score", { points: scoreDelta, effect });
      return;
    }

    const me = state.soloPlayers.find((player) => player.id === (state.playerId || "solo-player")) || state.soloPlayers[0];
    me.score = Math.max(0, normalizeScoreValue(me.score) + scoreDelta);
    me.effect = effect;
  }

  function applyOptimisticMultiplayerScore(points, effect) {
    const state = getState();
    const players = state.room?.players;
    if (!Array.isArray(players)) return;

    const me = players.find((player) => player.id === state.playerId);
    if (!me) return;

    me.score = Math.max(0, normalizeScoreValue(me.score) + points);
    me.effect = effect;
    state.leaderboard = [...players]
      .map((player) => ({
        id: player.id,
        username: player.username,
        avatar: player.avatar,
        guest: player.guest,
        score: normalizeScoreValue(player.score)
      }))
      .sort((a, b) => b.score - a.score || String(a.username).localeCompare(String(b.username)));
  }

  function updateSoloBots() {
    const state = getState();
    if (!state.gameplay || state.mode !== "solo") return;

    for (const bot of state.soloPlayers.filter((player) => player.id.startsWith("bot-"))) {
      const gain = Math.random() > 0.25 ? Math.floor(Math.random() * 13) : 0;
      bot.score += gain;
      bot.effect = gain > 0 ? "Bot combo" : "Mengintai";
    }
    updateGameHud();
  }

  function updateGameHud() {
    const state = getState();
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
    const leader = [...players].sort((a, b) => normalizeScoreValue(b.score) - normalizeScoreValue(a.score))[0];

    if (timer) timer.textContent = `${remaining}s`;
    if (score) score.textContent = normalizeScoreValue(me?.score);

    const activeEffects = [];
    const now = Date.now();

    if (state.gameplay.doubleScoreUntil > now) {
      const seconds = Math.ceil((state.gameplay.doubleScoreUntil - now) / 1000);
      activeEffects.push(`<span class="tag warn"><i class="fa-solid fa-coins" style="margin-right: 4px;"></i> ${seconds}s</span>`);
    }

    if (state.gameplay.slowCursorUntil > now) {
      const seconds = Math.ceil((state.gameplay.slowCursorUntil - now) / 1000);
      activeEffects.push(`<span class="tag danger"><i class="fa-solid fa-snowflake" style="margin-right: 4px;"></i> ${seconds}s</span>`);
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

  function normalizeScoreDelta(value) {
    const points = Number(value);
    if (!Number.isFinite(points)) return 0;

    return Math.round(points);
  }

  function normalizeScoreValue(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return 0;

    return Math.max(0, Math.round(score));
  }
}
