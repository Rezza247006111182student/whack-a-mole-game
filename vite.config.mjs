import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.VITE_LOCAL_BACKEND_URL || "http://localhost:3000";

  return {
    server: {
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: backendUrl
        },
        "/ws": {
          target: backendUrl,
          ws: true
        }
      }
    },
    preview: {
      host: "0.0.0.0"
    }
  };
});
