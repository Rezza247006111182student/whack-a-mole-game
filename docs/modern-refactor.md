# Modern Refactor Notes

Project ini sudah mulai dipisah untuk persiapan deploy frontend ke Vercel.

## Struktur

- `src/` adalah entry frontend modern berbasis Vite.
- `src/app.js` masih menjadi koordinator utama render UI dan gameplay.
- `src/core/constants.js` menyimpan konstanta view, mole, timing, dan audio menu.
- `src/core/config.js` menyimpan pembacaan env Vite, URL auth, dan URL WebSocket.
- `src/core/utils.js` menyimpan helper sanitasi username, random number, dan escaping HTML.
- `src/game/gameplayController.js` menyimpan logic solo match, spawn mole, efek mole, timer, audio gameplay, dan update HUD permainan.
- `src/services/supabaseAuth.js` menyimpan integrasi Supabase Auth dan sync profile.
- `src/services/usernameModeration.js` memanggil endpoint backend `/api/moderate-username` untuk moderasi username Gemini, lalu fallback ke filter lokal jika backend tidak aktif.
- `src/services/realtimeClient.js` menyimpan koneksi WebSocket multiplayer.
- `src/ui/bindings.js` menyimpan event listener untuk login, menu, lobby, room, game screen, leaderboard, dan settings.
- `src/ui/templates.js` menyimpan HTML template untuk login, menu, lobby, room, gameplay screen, leaderboard, dan settings.
- `public/` tetap menyimpan asset statis dan file legacy.
- `server.js` masih dipakai sebagai backend WebSocket lokal selama multiplayer belum dipindah ke Supabase Realtime.
- `vercel.json` mengarahkan Vercel untuk menjalankan `npm run build` dan memakai output `dist`.

## Development Lokal

Jalankan backend WebSocket lokal:

```bash
npm run dev:backend
```

Jalankan frontend Vite di terminal lain:

```bash
npm run dev
```

Frontend berjalan di `http://localhost:5173`. Koneksi `/ws` akan diproxy ke `http://localhost:3000`.
WebSocket multiplayer dibuat lazy: backend baru dicoba saat user membuka menu Multiplayer.

## Deploy Vercel

Set environment variable ini di dashboard Vercel:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_AUTH_REDIRECT_URL`
- `VITE_REALTIME_MODE`
- `VITE_WS_URL` jika multiplayer masih memakai backend WebSocket eksternal

Jika multiplayer belum dipindah ke Supabase Realtime, gunakan `VITE_REALTIME_MODE=disabled` untuk deploy frontend sementara tanpa spam koneksi WebSocket.

## Auth Register

Register email/password sudah memakai Supabase Auth melalui `supabase.auth.signUp()`. Login form juga bisa memakai Supabase jika input pertama berupa email dan password diisi; tanpa password, login tetap memakai mode prototype lokal.

Jika **Confirm email** aktif di Supabase, user baru belum memiliki session sampai email diverifikasi. Dalam kondisi ini data `auth.users` akan dibuat, tetapi row `public.profiles` baru tersinkron setelah user masuk dengan session aktif, kecuali project memakai trigger database untuk membuat profile otomatis.

Untuk profile otomatis saat register, tambahkan trigger di Supabase yang membuat row `public.profiles` dari `auth.users`.

Schema dan policy awal ada di `docs/supabase-schema.sql`, termasuk kolom `total_score` dan bucket `avatars`.

## AI Username Moderation

Kunci `GEMINI_API_KEY` hanya dipakai di backend `server.js` lewat endpoint `/api/moderate-username`. Saat development Vite, jalankan `npm run dev:backend` agar request `/api` bisa diproxy ke backend lokal.

Jika backend tidak aktif, frontend tetap berjalan dengan filter kata lokal sebagai fallback.
