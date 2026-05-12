export const VIEW = {
  LOGIN: "login",
  MENU: "menu",
  LOBBY: "lobby",
  ROOM: "room",
  GAME: "game",
  LEADERBOARD: "leaderboard",
  SETTINGS: "settings"
};

export const MOLES = [
  { type: "normal", label: "Mole", points: 10, effect: "Combo +10" },
  { type: "gold", label: "Golden", points: 18, effect: "Bonus emas" },
  { type: "freeze", label: "Freeze", points: 6, effect: "Fokus dingin" },
  { type: "bad", label: "Red Mole", points: 0, effect: "Bonus waktu +3s" }
];

export const MAX_ACTIVE_MOLES = 3;
export const MOLE_STAY_MIN_MS = 1500;
export const MOLE_STAY_MAX_MS = 2400;
export const RED_MOLE_BONUS_MS = 3000;
export const MAX_RED_MOLE_BONUS_MS = 60_000;

export const MENU_BGM_SRC = "asset/music/Lagu Menu Utama.mp3";
export const MENU_BGM_VOLUME = 0.32;

export const BAD_WORDS = [
  "anjing",
  "bangsat",
  "babi",
  "kontol",
  "memek",
  "ngentot",
  "tolol",
  "goblok"
];
