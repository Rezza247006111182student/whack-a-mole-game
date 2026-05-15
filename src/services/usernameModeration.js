import { isUsernameAllowed } from "../core/utils.js";

const MODERATION_TIMEOUT_MS = 4_500;

export async function moderateUsername(username) {
  const value = String(username || "").trim();

  if (!isUsernameAllowed(value)) {
    return {
      allowed: false,
      source: "local",
      reason: "Username tidak pantas. Coba nama lain.",
    };
  }

  const moderationMode = String(
    import.meta.env?.VITE_MODERATION_MODE || "auto",
  ).toLowerCase();
  const isLocalHost = ["localhost", "127.0.0.1"].includes(
    window.location.hostname,
  );
  const apiBaseUrl = getModerationApiBaseUrl();
  const shouldUseApi =
    moderationMode === "api" ||
    (moderationMode === "auto" && (isLocalHost || apiBaseUrl));

  if (!shouldUseApi) {
    return {
      allowed: true,
      source: "local",
      skippedAi: true,
      reason: "Moderasi AI dinonaktifkan di lingkungan ini.",
    };
  }

  const endpoint = `${apiBaseUrl}/api/moderate-username`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: value }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        allowed: true,
        source: "local",
        skippedAi: true,
        reason: "Moderasi AI belum tersedia.",
      };
    }

    const result = await response.json();
    return normalizeModerationResult(result);
  } catch {
    return {
      allowed: true,
      source: "local",
      skippedAi: true,
      reason: "Moderasi AI belum tersedia.",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getModerationApiBaseUrl() {
  const windowConfig = window.APP_CONFIG || {};
  const env = import.meta.env || {};
  const value = String(
    windowConfig.apiBaseUrl ||
      env.VITE_API_BASE_URL ||
      (["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? env.VITE_LOCAL_BACKEND_URL
        : "") ||
      "",
  ).trim();

  if (!value) return "";
  return value.replace(/\/+$/, "");
}

function normalizeModerationResult(result) {
  return {
    allowed: Boolean(result?.allowed),
    source: String(result?.source || "api").slice(0, 24),
    skippedAi: Boolean(result?.skippedAi),
    reason: String(
      result?.reason ||
        (result?.allowed ? "Username aman." : "Username tidak pantas."),
    ).slice(0, 180),
  };
}
