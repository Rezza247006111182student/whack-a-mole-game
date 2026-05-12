import { BAD_WORDS } from "./constants.js";

export function cleanUsername(value) {
  const username = String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 20);

  return username || "Player";
}

export function isUsernameAllowed(username) {
  const value = username.trim().toLowerCase();
  if (value.length < 2) return false;
  return !BAD_WORDS.some((word) => value.includes(word));
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
