# Plan improvement Dalang dari riset T3 Code (26 Nov 2026)

Sumber: `pingdotgg/t3code` commit `be5b14d8` (25 Nov 2026), dibaca di level kode: `docs/internals/16_performance-regressions.md`, `10_web-ui.md`, `apps/server/src/orchestration-v2/*` (CommandOutputHub, LiveStreamBudget, IdleCompaction, CommandPolicy), `socketHeartbeat.ts`, dan `docs/user/*`. Riset 19 Nov di `docs/PRD.md` ("Research: T3 Code") sudah mencakup session protocol, delegation, handoff, multi-account, usage, hidden-ref checkpoint, automation, dan MCP; semuanya sudah dikirim di v0.8 sampai v0.14. Plan ini hanya berisi hal baru: **pola performa** T3 Code yang belum diterapkan Dalang, plus beberapa fitur kecil.

Status: diputuskan 26 Nov 2026, belum dieksekusi. Schema saat ini v16 (`packages/core/src/db/client.ts:32`).

## 0. Rencana final (dipakai untuk eksekusi)

Bagian 1 sampai 5 adalah riset dan opsi. Bagian ini adalah keputusannya dan menggantikan urutan atau keputusan terbuka yang disebut di sana.

### Tujuan

Dalang harus andal dan cepat sebelum dipakai orang lain, dengan pengalaman yang sama di TUI (developer) dan web (pengguna awam). Bug ditemukan lewat tes dan rekaman, bukan dari laporan user. Prioritas: keandalan, lalu kecepatan, lalu alat baru untuk agent (browser dan connector).

Bukan tujuan: meniru T3 Code secara utuh (mesin workflow, remote, aplikasi mobile, visual reply HTML, permission mode per thread). Alasannya ada di bagian 4.

### Bukti dari pemakaian awal (DB dan log lokal maintainer, dibaca dari salinan)

| # | Masalah | Bukti |
| --- | --- | --- |
| B1 | Ask dengan Codex macet 3 menit lalu gagal | 2 dari 10 turn Codex `Provider session timed out` sekitar 187 detik. Log hanya berisi `Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces`; error fatal ini tidak dikenali, jadi Dalang menunggu idle timeout |
| B2 | Session tertinggal `working` | 2 session (Auto dan Quick) masih `working`, padahal run-nya `failed` atau `stopped` karena server restart |
| B3 | Verify gagal karena worktree tanpa dependency | `tsc: not found`; agent mencoba `pnpm install` dan kena `EROFS` di sandbox |
| B4 | Repo bersarang yang di-gitignore tidak ada di worktree | Satu run di workspace bersarang. Kemungkinan sudah tertutup v0.9; dikonfirmasi lewat R6 |
| B5 | Turn Lead lambat | Rata-rata Claude 39 detik (maksimal 168), Codex 19 detik, Antigravity 38 detik |
| B6 | Tes tidak menangkap B1 sampai B3 | `ReplayCliRunner` tidak mendukung stdin interaktif, jadi jalur session tidak pernah dites; sandbox, worktree nyata, dan restart juga tidak |
| B7 | JSON mentah tampil di stream | Agent menulis pesan progres lalu jawaban JSON; teks gabungannya tidak diawali `{`, jadi `liveReplyText` mengembalikan semuanya mentah. Direproduksi; 4 turn di log menunjukkan pola ini. Berlaku untuk TUI dan web |
| B8 | Menunggu terasa buta | TUI hanya menampilkan `Working`, `Thinking`, atau `Running a command`, tanpa target, waktu, riwayat langkah, atau fase start |

### Keputusan

| # | Keputusan | Alasan |
| --- | --- | --- |
| D1 | Keandalan dulu (v0.15), kecepatan (v0.16), alat agent (v0.17); bridge Telegram dan Slack digeser ke v0.18 dan v0.19 | Bridge menambah pintu masuk yang mewarisi bug inti. Memperbaiki inti sekali berlaku untuk TUI, web, dan bridge |
| D2 | Setiap bug yang ditemukan diperbaiki dengan replay test yang gagal sebelum perbaikan | Praktik T3 Code: transcript asli diputar lewat server, adapter, dan DB sungguhan |
| D3 | Paritas TUI dan web lewat satu daftar skenario yang dites di keduanya | Developer memakai TUI, pengguna awam memakai web |
| D4 | Browser untuk agent: **opsi C**, yaitu daemon browser yang dikelola Dalang di luar sandbox, dipanggil lewat CLI dengan snapshot dan ref. Ditambah **bukti browser di gate**: reviewer menyertakan screenshot dan log console di Gate 2 | Bisa dipakai ketiga provider lewat shell, paling hemat token, dan Chromium tidak perlu user namespace bertingkat di sandbox. Bukti di gate adalah keunggulan khas pipeline Dalang |
| D5 | Connector pihak ketiga: allowlist MCP server per project, diteruskan secara konsisten ke ketiga provider. Isolasi Claude (`--setting-sources project --strict-mcp-config`) tetap ada | Hasil tidak berubah hanya karena fallback pindah provider, dan MCP yang belum disetujui tidak ikut berjalan |
| D6 | Akses internet: tidak ada fitur baru. Verifikasi per provider di matriks R6 (shell network, WebSearch Claude, `web_search` Codex) | Sandbox tidak memutus network; yang belum pasti hanya tool search tiap provider |
| D7 | WebSocket: subscribe per project dan per run lewat pesan di socket yang sama | TUI dan web sering pindah project, dan reconnect tiap kali itu boros |
| D8 | SQLite `synchronous = NORMAL` dan `busy_timeout = 5000` | Aman dengan WAL; state penting juga tersimpan di git dan `.dalang/` |
| D9 | Proses CLI hidup lintas turn (S1) hanya dikerjakan bila baseline K1 menunjukkan cold start di atas sekitar 1,5 detik per turn | Perubahan besar dan berisiko; diputuskan dengan angka |
| D10 | Fitur kecil yang tidak membantu keandalan atau kecepatan ditunda: prompt link (F4), model murah untuk judul dan commit (F5), saran compaction (F7), pertanyaan subtask ke induk (W3), dan sisa handoff bisa dibaca (W4) | Fokus fase. Ditinjau lagi setelah v0.19 |

### Sudah dikerjakan: perekaman (R0)

- `RecordingCliRunner` (`packages/core/src/testing/recording-runner.ts`) aktif bila `DALANG_RECORD_DIR` diset, untuk TUI dan web. Setiap panggilan `claude`, `codex`, dan `agy` disimpan sebagai JSON yang cocok dengan `ReplayTurnEntry`, ditambah waktu tiap baris stdout, stdin interaktif, durasi, dan status timeout. Secret di-redact; file bermode 600.
- `packages/core/scripts/recordings.mjs summary|transcript` menampilkan ringkasan timing dan kegagalan, atau mengubah rekaman menjadi transcript replay.
- Bukti: `recording-runner.test.ts`; test core dan server lulus; smoke test dengan `--version` ketiga CLI asli. Cara pakai ada di `docs/TROUBLESHOOTING.md`.

### v0.15 "Andal": keandalan dan paritas

Selesai bila: matriks R6 (Ask, Quick, dan Full × Claude, Codex, dan Antigravity × TUI dan web) lulus di tiga repo nyata tanpa intervensi manual; B1 sampai B8 tertutup, masing-masing dengan replay test atau test unit yang gagal sebelum perbaikan.

| Urutan | Item | Isi | Ukuran |
| --- | --- | --- | --- |
| 1 | R4 | Setup worktree: perintah setup per project (deteksi otomatis dari lockfile, bisa diubah di Config) dijalankan Dalang setelah worktree dibuat, sebelum agent mulai, dengan akses tulis ke worktree dan cache package manager. Dikerjakan pertama karena eksekusi plan ini lewat Dalang butuh verify yang jalan (B3) | Sedang |
| 2 | R8 | Perbaikan JSON bocor (B7): `liveReplyText` mencari awal JSON jawaban di mana pun dalam teks (termasuk setelah pesan progres atau di dalam fence), dan teks sebelum JSON dianggap pesan progres, bukan jawaban. Test dengan sampel dari log | Kecil |
| 3 | R2 | Error fatal provider gagal cepat (B1): pola stderr fatal per adapter menghentikan turn dengan pesan dan langkah perbaikan. Cari akar B1 (sandbox bawaan `codex app-server`, jalur Ask tanpa bwrap Dalang, atau AppArmor yang memblokir userns tanpa privilege) | Kecil sampai sedang |
| 4 | R3 | Pemulihan saat startup (B2): session `working` tanpa run hidup dikembalikan ke `idle` dengan pesan di chat. Test restart | Kecil |
| 5 | R1 | Replay jalur session: `ReplayCliRunner` mendukung stdin interaktif dan memutar `stdinWrites` serta stdout dari rekaman sebagai percakapan. Menutup B6 | Sedang |
| 6 | U1 | Tampilan menunggu (B8), TUI dan web sama: header (peran, provider, model, waktu berjalan), fase start dan resume dari sinyal protokol, daftar langkah dengan target (file, pola cari, command) dan durasi, pesan progres agent sebagai baris redup, jawaban streaming terpisah di bawahnya. Setelah selesai, langkah dilipat menjadi satu ringkasan yang bisa dibuka. Gabungan F1 dan S5 | Sedang |
| 7 | U2 | Web streaming per token dari `lead.text` (S2); sekarang hanya TUI yang melakukannya | Kecil |
| 8 | R5 | Paritas TUI dan web: satu daftar skenario dipakai `browser-replay.test.ts` dan test room di PTY, dengan transcript yang sama | Sedang |
| 9 | R7 | Keandalan kecil: log async per run (P1); index FK, `busy_timeout`, dan `synchronous = NORMAL` (P5, migrasi v17); heartbeat dan reconnect WebSocket; idempotensi `delegate_task` (W2); dedupe webhook per delivery id (W6) | Kecil masing-masing |
| 10 | F6 | `/triage` (TUI) dan "Report a problem" (web): membuka sesi Ask berisi versi, OS, `dalang doctor`, log server terakhir yang sudah di-redact, dan ringkasan rekaman bila ada. Agent bertanya dulu sebelum membuat issue | Kecil |
| Paralel | R6 | Dogfood terstruktur: matriks di atas pada salinan scratch tiga repo nyata (salah satunya `dalang`, satu workspace bersarang), dengan `DALANG_RECORD_DIR`. Termasuk verifikasi akses internet per provider (D6). Setiap kegagalan menjadi item perbaikan dan transcript replay | Berulang |

### v0.16 "Cepat": kecepatan

Selesai bila: angka dari rekaman (bukan perkiraan) menunjukkan perbaikan terhadap baseline K1, budget `tui-bench` lulus, dan test payload lulus (session 2.000 message: respons awal di bawah 200 KB; socket project lain menerima 0 byte log).

| Urutan | Item | Isi |
| --- | --- | --- |
| 1 | K1 | Baseline dari rekaman R6: waktu ke output pertama, ke token pertama, dan total, per provider dan per jalur, untuk turn pertama dan lanjutan |
| 2 | K2 | Lalu lintas dan render: event per project dan hub output per run dengan penggabungan 100 ms (P2, D7); state live keluar dari komponen root di web dan TUI (P3); invalidasi berbasis event menggantikan polling 3 detik (P4); history session dipaging (P6) |
| 3 | K3 | Tampilan stream: markdown dirender per blok, hanya blok terakhir yang di-parse ulang (S4); teks live untuk coder run (S3); output command Codex live (S6); Stop ditahan sampai turn benar-benar mulai (S7) |
| 4 | K4 | Composer: paste 32 KiB atau lebih menjadi lampiran (F2), dan draft disimpan per session (F3) |
| 5 | K5 | Proses CLI hidup lintas turn untuk Ask dan Lead (S1), hanya bila K1 memenuhi D9 |

### v0.17 "Alat": browser dan connector untuk agent

Selesai bila: di project web, coder bisa membuka dev server, berinteraksi, dan memeriksa hasil lewat browser di ketiga provider; reviewer menyertakan screenshot dan log console di Gate 2; dan satu MCP server pihak ketiga yang ada di allowlist bekerja sama di ketiga provider.

| Urutan | Item | Isi |
| --- | --- | --- |
| 1 | A1 | Browser Dalang (D4): daemon Chromium headless (`playwright-core`) dijalankan server Dalang di luar sandbox, satu context per run. Perintah shell `dalang browser open|snapshot|click|type|wait|console|screenshot` dengan snapshot pohon aksesibilitas dan ref. Hanya boleh mengakses `localhost` dan internet publik; alamat jaringan privat diblok. Browser diunduh sekali saat pertama dipakai. Instruksi di prompt hanya untuk project web, dan browser hanya dipakai bila task membutuhkannya |
| 2 | A2 | Deteksi dev server: port yang dibuka proses run dikenali, sehingga agent dan user tahu URL yang dites |
| 3 | A3 | Bukti browser di gate: reviewer membuka halaman yang diubah dan menyimpan screenshot serta log console ke `.dalang/evidence/<task>/`. Web menampilkannya di Gate 2; TUI menampilkan path dan ringkasan console |
| 4 | A4 | Allowlist MCP per project (D5): Config → Tools memilih MCP server mana yang boleh dipakai; diteruskan ke Claude (`--mcp-config`), Codex (`-c mcp_servers.*`), dan Antigravity (ACP `mcpServers`, sekaligus menyelesaikan W1) |
| 5 | A5 | Gate dengan alasan (W5): menolak di Gate 2 atau persetujuan plan bisa mewajibkan alasan, dan alasan itu masuk ke prompt fix atau replan berikutnya |

### v0.18 dan v0.19

Telegram bridge (sebelumnya v0.15) dan Slack bridge (sebelumnya v0.16), tanpa perubahan isi.

### Eksekusi dari Dalang sendiri

- **Uji apa adanya.** Fase dijalankan di Dalang dengan satu prompt, misalnya "implementasi fase 0.15 dari docs/plans/2026-11-26-t3code-improvement-plan.md". Tidak ada task yang dipecah lebih dulu dan tidak ada perbaikan di luar Dalang. Setiap kegagalan atau intervensi manual adalah temuan, dan Dalang yang diperbaiki sampai prompt tunggal itu cukup.
- Kriteria tambahan v0.15: fase berikutnya (v0.16) bisa dijalankan dari satu prompt yang sama, sampai merge, tanpa intervensi manual selain menjawab gate.
- Syarat tes yang sah (bukan bantuan ke Dalang): plan dan perubahan source sudah di-commit, karena worktree dibuat dari HEAD git; jalankan dengan `DALANG_RECORD_DIR` dari build source, karena `dalang-cli` yang terpasang belum punya perekaman.
- Prediksi kegagalan pertama: verify task gagal karena B3. Worktree hanya berisi file yang tercatat git, jadi `node_modules` tidak ada; agent dan verify sama-sama jalan di sandbox bwrap yang membuat home read-only, sehingga `pnpm install` (termasuk `--offline`) gagal dengan `EROFS`. Bila terbukti, R4 adalah perbaikan pertama.
- Catat setiap temuan (perintah, rekaman, dan intervensi yang dibutuhkan) sebagai item baru di fase ini, dengan replay test sebelum perbaikan (D2).
- Dalang yang dipakai adalah build `dalang-cli` yang terpasang. Perubahan source baru berlaku setelah build, pasang ulang, dan restart.
- PRD (`docs/PRD.md`, tabel fase dan bagian v0.15 dan v0.16) diperbarui saat eksekusi v0.15 dimulai.

## 1. Prinsip performa T3 Code yang relevan

| Prinsip T3 Code | Di mana | Kondisi Dalang |
| --- | --- | --- |
| Output command live **tidak lewat event bus utama**. Hub terpisah, client subscribe hanya saat baris command dibuka, frame digabung tiap 100 ms, subscriber yang tertinggal dikirim tail saja (maks 16 KB append) | `CommandOutputHub.ts` | Setiap baris log run di-broadcast sebagai event `run.log` ke **semua** socket, semua project (`packages/server/src/app.ts:289-305`) |
| Snapshot thread dibatasi byte dan baris; history di-page; body tool mentah tidak dikirim | `transferBudgetV2.integration.test.ts` | `getDiscuss`/`getSessionDetail` mengembalikan **seluruh** message session tanpa limit (`lead.ts:2331-2336`), dan di-refetch tiap `room.message` |
| Log ditulis async dan serial; write sync membekukan event loop | perf doc, "Persistence invariants" | `appendDalangLog` membuka, menulis sync, dan menutup file **per baris** (`executor.ts:474-481`); `TurnLogger.write` memakai `fs.writeSync` (`adapters/logger.ts`) |
| Cursor dan query recovery harus memakai index, bukan scan | perf doc | Tidak ada index untuk `messages.session_id`, `sessions.project_id`, `tasks.plan_id`, `runs.task_id`, `reviews.task_id` (hanya 12 index, semuanya untuk tabel v9+). SQLite tidak membuat index FK otomatis |
| Heartbeat WS 20 detik (reverse proxy menutup socket diam 60 detik); client reconnect | `socketHeartbeat.ts` | Tidak ada heartbeat. Web tidak reconnect: `onclose` hanya invalidate `auth-status` (`App.tsx:417-430`) |
| Komponen besar tidak re-render per delta; state cepat di store eksternal | `10_web-ui.md` | Di web, `run.log` dan `lead.log` memanggil `setState` di **root `App`** per baris (`App.tsx` ~480-560) sehingga seluruh pohon re-render. Di TUI, `RoomApp` memanggil `setActivityPreviews` per baris log (`RoomApp.tsx:478-486`), melanggar aturan 2 di `docs/TUI_PERFORMANCE.md` |
| Kerja background digabung per thread | perf doc | Satu `run.finished` meng-invalidate 8 query (execution, session-detail, plan, guard, sessions, providers-status, statistics, run-log), ditambah polling `refetchInterval` 3 detik selama run aktif (`App.tsx:259`, `WorkView.tsx:72`, `QuickSessionView.tsx:95`) |
| Benchmark A/B + budget di CI | `scripts/metrics/*` | Hanya ada `packages/cli/scripts/tui-bench.mjs` untuk TUI. Server dan web belum punya budget |

Temuan tambahan di Dalang: ringkasan session (`lead.ts:3805-3850`) menjalankan tiga query per session (semua versi plan, task, **semua id message** hanya untuk dihitung). Daftar session dengan N item jadi 3N query.

## 2. Plan performa

Urutan berdasarkan dampak per usaha. Setiap fase bisa dirilis sendiri.

### P1. Log run async dengan satu handle per run (kecil)

- Ganti `appendDalangLog` (open/write/close per baris) dengan satu `TurnLogger` per run yang dibuka saat run mulai dan ditutup saat run selesai.
- `TurnLogger.write` memakai `fs.createWriteStream` (async, urutan terjaga) dengan flag `O_NOFOLLOW` yang sama. `close()` mengembalikan promise yang menunggu flush, dan wajib di-await sebelum log dibaca reviewer atau handoff.
- Jaga redaksi secret tetap di jalur write.
- Bukti: test yang ada untuk logger dan handoff lulus; test baru memastikan baris tidak hilang dan urutan benar setelah `close()`.

### P2. Event per project dan hub output run (sedang, dampak terbesar)

- `/ws?projectId=<id>`: server hanya mengirim event project itu. Tanpa parameter, server mengirim event ringkas lintas project (`sessions.updated`, `provider.updated`, `automation.*`) untuk sidebar. Web dan TUI sama-sama sudah tahu project aktif.
- `run.log` dan `lead.log` keluar dari broadcast umum. Client mengirim `{subscribe: runId}` saat panel log atau aktivitas run terbuka. Server menggabungkan baris per subscriber tiap 100 ms dan mengirim tail (bukan seluruh backlog) bila subscriber tertinggal lebih dari 16 KB. Pola ini mengikuti `CommandOutputHub`, tapi cukup satu `Map<runId, Set<socket>>` dan buffer per socket, tanpa abstraksi baru.
- Preview aktivitas satu baris (yang dipakai TUI dan kartu aktivitas web) tetap dikirim untuk semua run project aktif, dengan throttle maksimal 4 per detik per run.
- Heartbeat: server mengirim `{"type":"ping"}` tiap 20 detik. Web dan TUI reconnect dengan backoff (1, 2, 5, 10 detik), lalu invalidate query project aktif setelah tersambung lagi.
- Auth tetap diperiksa per event seperti sekarang (`auth.canAccess`). Socket MCP atau token yang scoped ke satu project tidak boleh subscribe project lain.
- Bukti: test server untuk filter project, subscribe dan unsubscribe, tail saat tertinggal, dan penolakan subscribe lintas project; test reconnect di web.

### P3. State live keluar dari root komponen (sedang)

- Web: `liveBySession`, `runLogsByRunId`, dan activity feed pindah ke store eksternal kecil (pola `useSyncExternalStore` yang sama dengan `LiveReply.tsx` di TUI). Update digabung per `requestAnimationFrame`. Hanya panel log dan aktivitas yang subscribe; `App` tidak re-render per baris.
- TUI: `activityPreviews` pindah dari `RoomApp` ke store yang sama polanya, sesuai aturan 2 `TUI_PERFORMANCE.md`.
- Bukti: `tui-bench.mjs` ditambah stream `run.log` 50 baris per detik dari empat agent, budget tetap (frame p95 16 ms, keystroke p95 80 ms). Untuk web, hitung render `App` selama stream replay (React Profiler di test browser replay yang sudah ada); targetnya 0 render `App` per baris log.

### P4. Invalidasi berbasis event, bukan polling (kecil)

- Hapus `refetchInterval` 3 detik di `App.tsx`, `WorkView.tsx`, dan `QuickSessionView.tsx`. Event `run.started`, `run.finished`, `review.finished`, dan `plan.updated` sudah mencakup semua perubahan state yang di-poll. Pertahankan satu refetch saat reconnect (P2).
- Satu fungsi `invalidateProject(projectId, keys)` yang menggabungkan invalidasi dalam jendela 150 ms, sehingga rentetan event saat merge atau review tidak memicu belasan fetch.
- `statistics` dan `providers-status` cukup di-invalidate saat `run.finished` atau `lead.turn_finished`, tidak saat `run.started`.
- Bukti: test replay E2E yang ada tetap lulus; hitung request HTTP selama satu run Quick sebelum dan sesudah.

### P5. Index DB dan pragma (kecil, butuh migrasi v17)

- Migrasi v17, hanya `CREATE INDEX IF NOT EXISTS`, tanpa perubahan kolom:
  - `messages(session_id, created_at)`
  - `sessions(project_id, updated_at)`
  - `plans(session_id, version)`
  - `tasks(plan_id)`
  - `runs(task_id)`, `runs(project_id, started_at)`
  - `reviews(task_id)`
  - `provider_events`: kolom yang dipakai query limit atau fallback. Cek dulu dengan `pragma table_info` dan query di `stats.ts` dan `scheduler.ts`.
- Pragma saat open: `synchronous = NORMAL` (aman dengan WAL; transaksi terakhir bisa hilang saat listrik mati, tapi DB tidak rusak) dan `busy_timeout = 5000`.
- Ringkasan session: ganti pengambilan semua id message dengan `count(*)`, dan ambil hanya plan versi terbaru (`limit 1`). Untuk daftar session, hitung message dengan satu query `GROUP BY session_id`.
- Bukti: test upgrade v16 ke v17 (skill `db-migration-upgrade-check`); `EXPLAIN QUERY PLAN` untuk query message, session, dan task menunjukkan `USING INDEX`.

### P6. History session terbatas (sedang)

- `GET /api/projects/:id/sessions/:sessionId` dan endpoint discuss menerima `limit` (default 100) dan `before` (cursor `created_at, id`). Respons berisi `hasMore`.
- Web dan TUI memuat halaman lama saat scroll ke atas. Event `room.message` membawa `messageId`, jadi client cukup mengambil message baru itu (`?after=`), tidak me-refetch seluruh history.
- Bukti: test budget payload: session dengan 2.000 message, respons awal di bawah 200 KB; test paging maju dan mundur tidak melompati atau menggandakan message.

### P7. Benchmark dan budget (kecil, menyertai P2 sampai P6)

- Tidak membangun harness A/B seperti T3 Code. Cukup:
  - perluas `tui-bench.mjs` (P3);
  - satu test integrasi server: replay run dengan 10.000 baris log, ukur byte WS yang diterima socket project lain (harus 0) dan socket yang tidak subscribe log (hanya preview ber-throttle);
  - test budget payload P6.
- Tambah bagian "Server and web budgets" di `docs/TUI_PERFORMANCE.md`, atau ganti namanya jadi `PERFORMANCE.md`.

## 2b. Performa per CLI dan tampilan stream respons

Sumber T3 Code: `orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, `AntigravityAdapterV2.ts`, `ProviderTextDeltaCoalescer.ts`, `apps/web/src/components/chat/markdownStreamBlocks.ts`, `docs/internals/03_providers.md`.

### Cara T3 Code melakukannya

- **Proses agent hidup lintas turn.** Claude memakai Agent SDK `query` yang tetap hidup, Codex memakai satu proses `codex app-server` per session, dan Antigravity memakai session ACP. Turn berikutnya dikirim ke proses yang sama, jadi tidak ada biaya cold start CLI maupun pemuatan ulang transcript per turn. Proses idle ditutup oleh cleanup; pekerjaan background yang masih berjalan mencegahnya.
- **Satu coalescer untuk semua provider.** Delta teks dikumpulkan per `(turnId, itemId)` dan di-flush tiap 50 ms (teks jawaban dan reasoning), atau 400 ms untuk plan Codex. Saat item selesai, teks final ditulis sekali.
- **Jenis stream dipisah:** teks jawaban, reasoning (`thinking_delta` Claude, `item/reasoning/*Delta` Codex), output command (`item/commandExecution/outputDelta`, ke hub, bukan ke event store), dan plan.
- **`startupPhase` dari sinyal protokol** (bukan timer) ditampilkan sampai output pertama, supaya jeda cold start tidak terlihat seperti hang.
- **Render markdown bertahap.** `splitMarkdownBlocks` memotong teks di batas blok yang aman; blok yang sudah selesai di-memo, hanya blok terakhir yang di-parse ulang tiap batch. Timeline memakai list virtual (`@legendapp/list`).
- **Early stop** baru dikirim setelah provider memberi sinyal turn dimulai; stop sebelum itu bisa diabaikan provider atau membuat session macet.

### Kondisi Dalang per CLI

| CLI | Jalur turn | Delta teks | Catatan |
| --- | --- | --- | --- |
| Claude | Proses `claude -p --output-format stream-json` **baru per turn**, lanjut dengan `--resume` (`adapters/claude.ts:413-451`) | `text_delta` hanya bila `onTextDelta` diberikan (Ask dan Lead). `thinking_delta` dibuang | stdin stream-json dipakai untuk steering dalam satu turn, bukan untuk turn berikutnya |
| Codex | `codex app-server` bila runner mendukung stdin interaktif, selain itu `codex exec --json` (`codex.ts:315-323`). Proses **baru per turn** di kedua jalur | `app-server`: `item/agentMessage/delta`. `exec`: tidak ada delta, pesan muncul utuh (`codex.ts:412`) | Reasoning delta dan `commandExecution/outputDelta` tidak dipakai; output command baru terlihat saat item selesai |
| Antigravity | `agy acp --stdio` (session ACP), **baru per turn** (`antigravity.ts:366, 453-470`) | `agent_message_chunk` | `-p --output-format stream-json` tetap dipakai sebagai fallback |
| Coder run (executor) | Sama seperti di atas | **Tidak ada** `onTextDelta` di `executor.ts`; layar hanya menampilkan aktivitas dari baris log | |

Tampilan:

- **Lead dan Ask** membatch delta menjadi `lead.text` tiap 50 ms (`lead.ts:1571-1590`), setara dengan coalescer T3 Code. Namun **web tidak membaca `lead.text`**: web menyusun teks live dari baris log `lead.log` (`web/src/lib/liveTurn.ts`), sementara baris `stream_event` sengaja tidak masuk log (`claude.ts:488-505`). Akibatnya web menampilkan jawaban per pesan `assistant` utuh, bukan per token. Hanya TUI (`LiveReply.tsx`) yang streaming per token.
- `web/src/components/Markdown.tsx` mem-parse seluruh teks dengan `react-markdown` setiap render. TUI `LiveReply` juga mem-parse ulang seluruh teks tiap batch (sudah dicatat di aturan 4 `TUI_PERFORMANCE.md`).
- Belum ada indikator fase startup. Jeda antara Send dan output pertama (spawn CLI, resume session, MCP, model) tidak dijelaskan ke pengguna.

### Plan tambahan

**S0. Ukur dulu (kecil, wajib sebelum S1).** Script yang mencatat, per provider: waktu spawn sampai event pertama, sampai token teks pertama, dan sampai turn selesai, untuk turn pertama dan turn lanjutan (`--resume` atau `thread/resume`). Prompt singkat dan model termurah, tiga kali per provider. Tanpa angka ini, S1 belum bisa diputuskan.

**S1. Proses session hidup lintas turn (besar, putuskan setelah S0).** Session Ask dan Lead menahan proses Claude (stdin stream-json), `codex app-server`, atau `agy acp` setelah turn selesai, lalu mengirim turn berikutnya ke proses itu. Proses ditutup setelah idle 10 menit, saat session dihapus, saat model atau effort berubah, atau saat server berhenti. Batasi jumlah proses idle per provider (misalnya 3, yang paling lama dipakai ditutup dulu). Coder run tetap satu proses per run, karena worktree dan sandbox berbeda per task. Risiko: kebocoran proses, state sandbox yang terbawa antar turn, dan limit paralel F-12 harus menghitung proses idle. Hanya dikerjakan bila S0 menunjukkan cold start di atas sekitar 1,5 detik per turn.

**S2. Web membaca `lead.text` (kecil, dampak UX terbesar).** Teks live di web berasal dari `lead.text` (sudah ter-batch 50 ms), disimpan di store eksternal dari P3. `lead.log` hanya dipakai untuk aktivitas. Teks final tetap diambil dari message tersimpan, dengan pola yang sama seperti TUI: teks live dipertahankan sampai message tersimpan sudah di-fetch, jadi tidak berkedip.

**S3. Delta untuk coder run (kecil).** Executor meneruskan `onTextDelta` lewat batcher 50 ms yang sama, sebagai event `run.text`, dan hanya dikirim ke subscriber run itu (hub P2). Kartu run menampilkan paragraf terakhir agent.

**S4. Markdown bertahap (kecil sampai sedang).** Teks live dipecah di batas blok yang aman, dengan aturan konservatif: blank line di luar fence kode. Bila teks memakai sintaks lintas blok (definisi link, footnote, HTML), tetap parse teks utuh. Blok selesai di-memo per indeks, hanya blok terakhir yang dirender ulang. Dipakai di web `Markdown` untuk teks live dan di TUI `LiveReply`. Test: hasil render gabungan blok sama dengan render teks utuh untuk sejumlah sampel.

**S5. Fase startup dan reasoning (kecil).** Adapter mengirim `phase: 'starting' | 'resuming' | 'thinking'` dari sinyal nyata (proses spawned, event `system/init` atau `thread/started` atau `session/new`, delta reasoning pertama), dan UI menampilkannya sampai teks pertama. Isi reasoning tidak ditampilkan; cukup status "thinking".

**S6. Output command Codex live (kecil, ikut P2).** `item/commandExecution/outputDelta` di jalur `app-server` diteruskan ke hub output run, sehingga output command panjang terlihat saat berjalan.

**S7. Stop setelah turn dimulai (kecil).** Tombol Stop sebelum event mulai turn ditahan sampai event itu datang (dengan batas waktu, lalu proses di-kill). Perlu dicek dulu apakah ada laporan session macet setelah Stop; kalau tidak ada, cukup tambahkan test.

Urutan: S2 dan S0 dulu (murah, dan S2 langsung terasa di web), lalu S4, S5, S3, S6. S1 bergantung pada angka S0.

## 2c. Workflow antar provider

Sumber T3 Code: `docs/user/workflows.md`, `skills/t3-workflows/SKILL.md`, `apps/server/src/workflows/workflowAgent.ts`, `mcp/toolkits/{orchestrator,project,thread,worktree}/tools.ts`, `orchestration-v2/{ContextHandoffService,ProviderSwitchService,DelegatedTaskQuestionReactor}.ts`, `docs/user/portable-handoffs.md`.

T3 Code punya tiga mekanisme, dari yang paling terstruktur sampai paling bebas.

### 1. Workflows (Labs, off by default)

- File TypeScript di `~/.t3/workflows/*.ts`, dijalankan secara durable dengan `effect/workflow`. Hasil setiap step disimpan (journal). Setelah server restart, run diputar ulang sampai titik terakhir. Step yang gagal membuat run **pause**, bukan hilang.
- Primitif: `step` (kode biasa), `agent` (agent di thread), `ask` (pertanyaan ke manusia, dengan pilihan, `requireReason`, link, dan timeout), `wait` dan `signal` (menunggu event), `invoke` dan `start` (workflow anak), `within(pool, {limit})` (batas paralel lintas run), serta trigger `every`, `daily`, webhook, dan issue/PR baru.
- **Antar provider terjadi per step.** Setiap `agent` bisa memilih `model: { instanceId, model, options }`, sehingga satu run bisa audit dengan Claude, fix dengan Codex, dan review dengan provider lain. Data antar step dikirim sebagai **nilai bertipe** (`returns: Schema`), bukan sebagai konteks percakapan. Melanjutkan percakapan (`thread: audit.thread`) hanya bisa di provider yang sama.
- **Hasil terstruktur:** agent harus memanggil tool MCP `t3_submit_output({ json })`, yang divalidasi terhadap JSON Schema dari `returns`. Bila turn selesai tanpa submit atau hasilnya tidak cocok, agent diminta memperbaiki **tanpa mengulang pekerjaan**, maksimal 2 kali (`CORRECTIONS = 2`). Setelah itu step gagal.
- **Kebijakan gagal:** agent yang crash dicoba sekali lagi. Agent yang menyerah atau timeout membuat run pause dan menunggu manusia; tidak ada retry otomatis. Agent yang gagal start (misalnya environment offline) retry otomatis seperti step biasa. Pola eskalasi resminya: `agent.try(...)`, lalu bila gagal `agent.try(..., { model: stronger })`.
- Idempotensi: setiap start butuh `--key`; key yang sama mengembalikan run yang sama. Webhook di-dedupe lewat header delivery (misalnya `X-GitHub-Delivery`).

### 2. Orkestrasi antar thread lewat MCP (pengganti `delegate_task` sejak riset 19 Nov)

- Tool: `t3_thread_launch` (thread baru, boleh provider atau model lain, `workspaceStrategy` worktree), `t3_thread_send` (`queue`, `steer`, `restart`, atau `auto`), `t3_thread_wait`, `t3_thread_read` (dipaging, termasuk sisa item yang terpotong), `t3_thread_interrupt`, `t3_thread_transfer` (`fork` atau `merge_back` konteks), `t3_worktree_handoff`, dan `t3_background_wait`.
- **Plafon izin:** thread yang diluncurkan atau dikirimi pesan tidak boleh punya mode lebih luas dari pemanggilnya ("modes cannot exceed yours").
- **Idempotensi:** `clientRequestId` dipakai ulang saat error atau balasan hilang, supaya tidak ada thread ganda.
- **Pertanyaan anak ke induk:** `DelegatedTaskQuestionReactor` meneruskan pertanyaan yang tertunda dari task anak ke thread induk, yang bisa menjawabnya. Selesainya anak membangunkan induk dengan pesan khusus ("delegated-completion wake").

### 3. Ganti provider di tengah thread

- `ProviderSwitchService`: thread tetap sama, session lama dilepas, dan session baru menerima **handoff portabel**: pilihan pesan dengan budget (default 16K token, `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`, 1K sampai 64K). Isinya permintaan awal, giliran terbaru, dan hasil command. Tidak ada ringkasan buatan agent, dan reasoning, state tool, serta lampiran tidak ikut. Codex menerima history secara native bila versinya mendukung; provider lain menerimanya sebagai konteks berlabel.
- Bagian yang terpotong diberi referensi; agent bisa membacanya lewat `t3_thread_read`.
- Bila konteks target penuh, T3 Code memulai percakapan baru dengan pilihan terbatas. Permintaan pengguna tidak pernah dipotong.

### Perbandingan dengan Dalang

| Aspek | T3 Code | Dalang |
| --- | --- | --- |
| Pipeline multi-tahap lintas provider | Workflow script buatan pengguna | Bawaan: Lead (brief, plan) → coder per task dengan routing per role/kompleksitas → reviewer di provider lain → fix loop → gate. Tidak perlu script |
| Hasil terstruktur | `t3_submit_output` + 2 koreksi | `result.json` + prompt repair (`executor.ts:2832`) |
| Delegasi di tengah run | Thread bebas, bisa bertingkat, berbagi checkout atau worktree | `delegate_task` dengan kedalaman 1, `files_allowed` subset, review, dan merge ke branch induk (lebih ketat) |
| Antigravity bisa mendelegasi | Ya (MCP lewat ACP) | **Tidak.** Dalang memakai `agy acp` tapi mengirim `mcpServers: []` (`antigravity.ts:514`). PRD v0.8 menyebut agy menolak MCP di `--settings`, tapi jalur ACP belum dicoba |
| Idempotensi delegasi | `clientRequestId` | Tidak ada. Retry setelah balasan hilang bisa membuat subtask ganda |
| Pertanyaan subtask ke induk | Diteruskan, induk bisa menjawab | Subtask hanya bisa selesai atau gagal |
| Konteks handoff yang terpotong | Bisa dibaca lewat tool | Hanya batas `handoffLimit`; sisanya tidak bisa diakses agent |
| Eskalasi model saat gagal | `agent.try` + `stronger` di script | Fallback profil (CLI, model, effort) setelah gagal (`executor.ts:3187`) |
| Ask di persetujuan manusia | Pilihan + `requireReason` + link + timeout | Gate y/n |
| Dedupe webhook | Header delivery | Timestamp signature + replay guard (v0.11.1); belum ada dedupe delivery id |

Kesimpulan: Dalang sudah menutup kebutuhan "workflow antar provider" lewat pipeline bawaannya, dan delegasinya lebih aman dari T3 Code. Mesin workflow durable sebaiknya tidak ditiru (lihat bagian 4). Yang layak diambil adalah celah kecil berikut.

### Plan tambahan

- **W1. MCP untuk Antigravity lewat ACP (kecil, cek dulu).** Isi `mcpServers` di `session/new` dengan endpoint MCP Dalang (bearer token lewat header, sesuai spec ACP). Bila agy menghormatinya, coder Antigravity bisa `delegate_task`. Bila tidak, catat hasilnya di PRD dan tutup item ini. Token tidak boleh muncul di log (redaksi yang sudah ada).
- **W2. Idempotensi `delegate_task` (kecil).** Parameter opsional `client_request_id`. Pasangan (run induk, id) yang sama mengembalikan task yang sudah ada. Simpan di kolom baru atau di metadata task (migrasi, bisa digabung dengan v17 dari P5).
- **W3. Pertanyaan subtask ke induk (sedang, opsional).** Subtask yang berhenti dengan status `blocked` beserta pertanyaannya dikembalikan ke `task_status`/`wait` milik induk. Induk menjawab lewat tool baru `task_answer`, yang melanjutkan subtask di session yang sama. Gate manusia tidak dilewati. Kerjakan hanya bila log menunjukkan subtask sering gagal karena kurang informasi.
- **W4. Sisa handoff bisa dibaca (kecil).** Bagian log run sebelumnya yang terpotong oleh `handoffLimit` diberi referensi `{runId, offset}`, dan tool MCP read-only `run_log_read` mengembalikan potongan berikutnya. Hanya untuk run di task yang sama.
- **W5. Gate dengan alasan (kecil).** Tolak (reject) di Gate 2 dan di persetujuan plan bisa mewajibkan alasan. Alasan itu masuk ke prompt fix atau replan berikutnya. TUI: `n` meminta satu baris alasan.
- **W6. Dedupe webhook per delivery id (kecil).** Simpan `X-GitHub-Delivery` (atau `X-Dalang-Delivery`) per automation selama 24 jam; pengiriman ulang dengan id yang sama tidak memicu run kedua.

Urutan: W1 (cek cepat), W2, W6, W5, W4. W3 menunggu data.

## 3. Plan fitur

Hanya fitur yang memperkuat pipeline Dalang (brief, plan, review, gate) dan murah dibangun.

| # | Fitur | Dari T3 Code | Bentuk di Dalang | Ukuran |
| --- | --- | --- | --- | --- |
| F1 | Activity log berkelompok | `activity-log.md` | Tool call berurutan dalam satu run digabung jadi satu ringkasan ("Ran 3 commands, edited 2 files"). Klik untuk membuka detail; output command baru di-subscribe saat dibuka (memakai hub P2). `parseRunLogActivity` sudah ada di web | Sedang |
| F2 | Paste besar jadi lampiran | `composer.md` | Paste 32 KiB atau lebih di composer menjadi file `.dalang/attachments/<id>.txt`, dan agent menerima path-nya. Batas pesan 120.000 karakter dengan pesan error yang jelas | Kecil |
| F3 | Draft composer per session | `composerDraftStore.ts` | Draft disimpan di `localStorage` per `projectId:sessionId` dan dipulihkan saat kembali ke session itu. TUI: disimpan di memori saja | Kecil |
| F4 | Prompt link | `prompt-links.md` | `/?project=<path-or-id>&mode=quick&prompt=...` membuka draft, **tidak pernah menjalankan**. Tombol "Copy prompt link" di composer. Berguna untuk komentar PR dan README | Kecil |
| F5 | Model kecil untuk teks pendek | `text-generation.md` | Judul session (sekarang `deriveSessionTitle` dari potongan pesan), pesan commit merge, dan judul serta deskripsi PR memakai profil routing `scribe` (default: model termurah provider Lead). Tetap jatuh ke cara sekarang bila gagal | Kecil sampai sedang |
| F6 | Triage diri sendiri | `triage.md` | Perintah `/triage` (TUI) dan menu "Report a problem" (web) membuka sesi Ask berisi versi, OS, `dalang doctor`, 200 baris log server terakhir (secret di-redact), dan link ke source tag versi tersebut. Agent bertanya dulu sebelum menulis issue | Kecil |
| F7 | Saran compaction sebelum cache habis | `IdleCompaction.ts` | Hanya untuk session Claude yang di-resume (v0.10): bila konteks di atas 100K token dan session idle mendekati habisnya prompt cache (5 menit untuk API key, 1 jam untuk langganan), tampilkan tombol "Compact now". Tanpa otomatisasi | Sedang, prioritas rendah |

Urutan yang disarankan: P1, P5, P4 (cepat, risiko rendah), lalu P2+P3 bersama, P6, F2, F3, F4, F1, F5, F6. F7 ditunda sampai ada keluhan biaya.

## 4. Sengaja tidak diambil

| T3 Code | Alasan |
| --- | --- |
| Workflows (script TS durable) | Tumpang tindih dengan Full mode (brief, plan, dependency) dan automation v0.11 |
| Visual replies (HTML render + headless browser 120 MB) | Unduhan besar, permukaan keamanan baru; Dalang bukan klien chat umum |
| Permission modes per thread | Model keamanan Dalang adalah sandbox, `files_allowed`, review, dan gate merge. Mode Supervised bertabrakan dengan run tanpa TTY |
| Remote, relay, aplikasi mobile, SnapShots | Sudah di "Not planned" PRD |
| Effect-TS, event sourcing penuh (`EventStore`, `Projection*`) | Rewrite besar. Masalah performa Dalang bisa diselesaikan dengan P1 sampai P6 di arsitektur sekarang |
| React Compiler + lint `no-manual-memo` | Layak dicoba nanti, tapi tidak menyelesaikan akar masalah (setState di root). Evaluasi setelah P3 |
| Harness metrik A/B lengkap | Terlalu besar untuk ukuran tim; P7 cukup |

## 5. Keputusan terbuka (sudah diputuskan di bagian 0, D1 sampai D10)

1. **P2, bentuk protokol.** Query param `projectId` saat connect (sederhana, ganti project berarti reconnect) atau pesan `subscribe` di socket yang sama (tanpa reconnect, sedikit lebih banyak kode). Rekomendasi: pesan `subscribe` untuk project dan run sekaligus, karena TUI dan web sering berpindah project.
2. **P5, `synchronous = NORMAL`.** Transaksi terakhir bisa hilang saat listrik mati. Rekomendasi: aktifkan, karena state penting ada juga di git dan `.dalang/`.
3. **F5, profil `scribe`.** Butuh baris routing baru di seed (migrasi data) atau cukup setting "Text model" di Config. Rekomendasi: setting di Config, tanpa perubahan tabel routing.
4. **Nomor rilis.** P1, P4, dan P5 bisa masuk patch 0.14.3. P2, P3, dan P6 mengubah protokol WS dan API, jadi lebih cocok di 0.15 (cek bentrok dengan rencana v0.15 bridge Telegram di PRD).
