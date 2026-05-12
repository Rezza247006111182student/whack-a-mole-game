import { createClient } from "@supabase/supabase-js";
import { hasSupabaseConfig } from "../core/config.js";

export function createSupabaseAuthService(config, callbacks = {}) {
  let supabase = null;
  let supabaseReadyPromise = null;
  let authSession = null;
  let authUser = null;

  async function init() {
    if (supabaseReadyPromise) return supabaseReadyPromise;

    supabaseReadyPromise = setup();
    return supabaseReadyPromise;
  }

  async function setup() {
    if (!hasSupabaseConfig(config)) return null;

    try {
      supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: {
          autoRefreshToken: true,
          detectSessionInUrl: true,
          persistSession: true
        }
      });

      const { data, error } = await supabase.auth.getSession();
      if (error) {
        callbacks.onSessionError?.(error);
      }

      if (data?.session) {
        await applySession(data.session);
      }

      supabase.auth.onAuthStateChange((event, session) => {
        if (session) {
          applySession(session);
        }

        if (event === "SIGNED_OUT") {
          authSession = null;
          authUser = null;
          callbacks.onSignedOut?.();
        }
      });

      callbacks.onReady?.();
      return supabase;
    } catch (error) {
      callbacks.onSetupError?.(error);
      return null;
    }
  }

  async function applySession(session) {
    authSession = session;
    authUser = session.user;
    await callbacks.onSession?.(session);
  }

  async function signInWithGoogle(redirectTo) {
    const client = await init();

    if (!client) {
      return {
        error: new Error("Supabase belum siap. Cek VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY.")
      };
    }

    return client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo }
    });
  }

  async function signUpWithEmail({ username, email, password, redirectTo }) {
    const client = await init();

    if (!client) {
      return {
        error: new Error("Supabase belum siap. Cek VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY.")
      };
    }

    const result = await client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectTo,
        data: {
          username,
          full_name: username
        }
      }
    });

    if (result.data?.session) {
      await applySession(result.data.session);
    }

    return result;
  }

  async function signInWithPassword({ email, password }) {
    const client = await init();

    if (!client) {
      return {
        error: new Error("Supabase belum siap. Cek VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY.")
      };
    }

    const result = await client.auth.signInWithPassword({ email, password });

    if (result.data?.session) {
      await applySession(result.data.session);
    }

    return result;
  }

  async function signOut() {
    if (!supabase || !authSession) return { skipped: true };
    return supabase.auth.signOut();
  }

  async function getProfile() {
    if (!supabase || !authUser) return { skipped: true, data: null };

    return supabase
      .from("profiles")
      .select("username, avatar_url, bio, total_score")
      .eq("id", authUser.id)
      .maybeSingle();
  }

  async function upsertProfile(profile) {
    if (!supabase || !authUser || profile.guest) return { skipped: true };

    return supabase
      .from("profiles")
      .upsert({
        id: authUser.id,
        username: profile.username,
        avatar_url: profile.avatar,
        bio: profile.bio || "",
        total_score: Number(profile.totalScore || 0),
        updated_at: new Date().toISOString()
      }, {
        onConflict: "id"
      });
  }

  async function uploadAvatar(file, currentAvatarUrl = "") {
    if (!supabase || !authUser) {
      return {
        error: new Error("Login Supabase diperlukan untuk upload foto profil.")
      };
    }

    const compressed = await compressAvatarImage(file);
    const filePath = `${authUser.id}/avatar-${Date.now()}.jpg`;
    const { error } = await supabase.storage
      .from(config.avatarBucket)
      .upload(filePath, compressed, {
        cacheControl: "3600",
        contentType: "image/jpeg",
        upsert: false
      });

    if (error) return { error };

    if (currentAvatarUrl) {
      removePreviousAvatar(currentAvatarUrl).catch((removeError) => {
        console.warn("Gagal menghapus avatar lama:", removeError.message);
      });
    }

    const { data } = supabase.storage
      .from(config.avatarBucket)
      .getPublicUrl(filePath);

    return { data: { path: filePath, publicUrl: data.publicUrl } };
  }

  async function addProfileScore(score) {
    const points = Math.max(0, Math.floor(Number(score) || 0));
    if (!supabase || !authUser || points <= 0) {
      return { skipped: true, data: null };
    }

    const current = await getProfile();
    if (current.error) return current;

    const nextTotal = Math.max(0, Number(current.data?.total_score || 0) + points);
    const { data, error } = await supabase
      .from("profiles")
      .update({
        total_score: nextTotal,
        updated_at: new Date().toISOString()
      })
      .eq("id", authUser.id)
      .select("total_score")
      .single();

    if (error) return { error };
    return { data: { totalScore: data.total_score } };
  }

  async function removePreviousAvatar(publicUrl) {
    const marker = `/storage/v1/object/public/${config.avatarBucket}/`;
    const index = publicUrl.indexOf(marker);
    if (index === -1) return;

    const rawPath = publicUrl.slice(index + marker.length);
    const decodedPath = decodeURIComponent(rawPath.split("?")[0]);
    if (!decodedPath.startsWith(`${authUser.id}/`)) return;

    await supabase.storage.from(config.avatarBucket).remove([decodedPath]);
  }

  return {
    init,
    signInWithGoogle,
    signInWithPassword,
    signUpWithEmail,
    signOut,
    getProfile,
    upsertProfile,
    uploadAvatar,
    addProfileScore
  };
}

function compressAvatarImage(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith("image/")) {
      reject(new Error("File harus berupa gambar."));
      return;
    }

    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const size = 256;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = size;
      canvas.height = size;

      const scale = Math.max(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      const x = (size - width) / 2;
      const y = (size - height) / 2;

      context.fillStyle = "#f5e5b8";
      context.fillRect(0, 0, size, size);
      context.drawImage(image, x, y, width, height);

      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Gagal memproses gambar."));
          return;
        }

        resolve(blob);
      }, "image/jpeg", 0.78);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Gambar tidak bisa dibaca."));
    };

    image.src = objectUrl;
  });
}
