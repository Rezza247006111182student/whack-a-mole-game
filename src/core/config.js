export function resolveAppConfig() {
  const viteEnv = import.meta.env || {};
  const windowConfig = window.APP_CONFIG || {};
  const isProductionBuild = viteEnv.PROD === true || viteEnv.PROD === "true";
  const configuredRealtimeMode = sanitizeConfigValue(
    getFirstConfigValue(windowConfig.realtimeMode, viteEnv.VITE_REALTIME_MODE)
  );

  return {
    supabaseUrl: sanitizeConfigValue(
      getFirstConfigValue(windowConfig.supabaseUrl, viteEnv.VITE_SUPABASE_URL)
    ),
    supabaseAnonKey: sanitizeConfigValue(
      getFirstConfigValue(windowConfig.supabaseAnonKey, viteEnv.VITE_SUPABASE_ANON_KEY)
    ),
    authRedirectUrl: sanitizeConfigValue(
      getFirstConfigValue(windowConfig.authRedirectUrl, viteEnv.VITE_AUTH_REDIRECT_URL)
    ),
    avatarBucket: sanitizeConfigValue(
      getFirstConfigValue(windowConfig.avatarBucket, viteEnv.VITE_SUPABASE_AVATAR_BUCKET)
    ) || "avatars",
    apiBaseUrl: sanitizeConfigValue(
      getFirstConfigValue(windowConfig.apiBaseUrl, viteEnv.VITE_API_BASE_URL)
    ),
    wsUrl: sanitizeConfigValue(
      getFirstConfigValue(windowConfig.wsUrl, viteEnv.VITE_WS_URL, viteEnv.VITE_WEBSOCKET_URL)
    ),
    realtimeMode: configuredRealtimeMode || (isProductionBuild ? "disabled" : "websocket")
  };
}

export function hasSupabaseConfig(config) {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey);
}

export function getAuthRedirectUrl(config) {
  return config.authRedirectUrl || window.location.origin;
}

export function getWebSocketUrl(config) {
  if (config.realtimeMode === "disabled") return "";
  if (config.realtimeMode && config.realtimeMode !== "websocket") return "";

  if (config.wsUrl) {
    return normalizeWebSocketUrl(config.wsUrl);
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

function getFirstConfigValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function sanitizeConfigValue(value) {
  const cleaned = String(value || "").trim();

  if (!cleaned || cleaned.startsWith("%VITE_") || cleaned.includes("your-")) {
    return "";
  }

  return cleaned;
}

function normalizeWebSocketUrl(value) {
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    return value;
  }

  if (value.startsWith("/")) {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}${value}`;
  }

  return value;
}
