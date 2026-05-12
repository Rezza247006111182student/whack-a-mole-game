import { isUsernameAllowed } from "../core/utils.js";

export async function moderateUsername(username) {
  const value = String(username || "").trim();

  if (!isUsernameAllowed(value)) {
    return {
      allowed: false,
      source: "local",
      reason: "Username tidak pantas. Coba nama lain."
    };
  }

  try {
    const response = await fetch("/api/moderate-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: value })
    });

    if (!response.ok) {
      return {
        allowed: true,
        source: "local",
        skippedAi: true,
        reason: "Moderasi AI belum tersedia."
      };
    }

    return response.json();
  } catch {
    return {
      allowed: true,
      source: "local",
      skippedAi: true,
      reason: "Moderasi AI belum tersedia."
    };
  }
}
