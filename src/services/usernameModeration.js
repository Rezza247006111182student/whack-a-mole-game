const MODERATION_TIMEOUT_MS = parsePositiveInteger(
  import.meta.env?.VITE_MODERATION_TIMEOUT_MS,
  15_000,
);

export async function moderateUsername(username) {
  const value = String(username || "").trim();

  if (value.length < 2) {
    return {
      allowed: false,
      source: "format",
      reason: "Username terlalu pendek.",
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
      allowed: false,
      source: "ai-unavailable",
      skippedAi: true,
      unavailable: true,
      reason: "Moderasi AI belum tersambung. Username belum bisa diubah.",
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
        allowed: false,
        source: "ai-unavailable",
        skippedAi: true,
        unavailable: true,
        reason: "Moderasi AI sedang tidak tersedia. Coba lagi nanti.",
      };
    }

    const result = await response.json();
    return normalizeModerationResult(result);
  } catch {
    return {
      allowed: false,
      source: "ai-unavailable",
      skippedAi: true,
      unavailable: true,
      reason: "Moderasi AI sedang tidak tersedia. Coba lagi nanti.",
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
    unavailable: Boolean(result?.unavailable),
    reason: String(
      result?.reason ||
        (result?.allowed ? "Username aman." : "Username tidak pantas."),
    ).slice(0, 180),
  };
}

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
