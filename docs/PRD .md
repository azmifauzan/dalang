# PRD — DALANG

Nov 18, 2026 · @Fauzan

## Ringkasan

DALANG adalah tool web yang berjalan lokal. Tool ini mengubah satu goal umum menjadi aplikasi yang berjalan, dengan mengorkestrasi Claude Code, Codex, dan Antigravity CLI sebagai satu tim kecil. Namanya sekaligus singkatan dari alurnya: **Discuss · Agree · List · Assign · Navigate · Guard**.

Pengguna cukup menulis goal di chat. Agent Lead berdiskusi dan mengonfirmasi scope, lalu memecahnya menjadi subtask kecil. Dispatcher kemudian membagikan setiap task ke agent sesuai peran, subscription, dan model yang diatur pengguna.

Semua proses berjalan di mesin pengguna dan memakai login CLI resmi. Tidak perlu API key tambahan. Manusia hanya terlibat di dua gerbang: menyetujui brief dan menyetujui merge.

## Latar belakang dan masalah

Developer yang punya beberapa subscription coding agent saat ini menjalankannya secara manual dan berurutan. Planning dikerjakan di satu tool, coding di tool lain, lalu testing dan review di tool ketiga, semuanya dalam workspace yang sama.

Alur manual ini menimbulkan empat masalah:

- **Handoff manual.** Plan dan konteks harus dipindahkan sendiri dari satu tool ke tool berikutnya.
- **Serial dan harus ditunggui.** Developer mengawasi setiap tahap dan baru bisa memulai tahap berikutnya setelah tahap sebelumnya selesai.
- **Kuota tidak terpakai merata.** Satu subscription bisa kena limit sementara yang lain menganggur.
- **Tidak ada jejak.** Keputusan, plan, dan hasil review tersebar di riwayat chat masing-masing tool.

Sudah ada beberapa tool sejenis, yaitu Agentty, ordewell, Orchestrator.inc, dan Vibe Kanban. Namun belum ada yang menggabungkan web UI lokal, fase interview sebelum planning, pengaturan subscription dan model per agent, serta dukungan Antigravity CLI dalam satu produk.

## Tujuan, non-tujuan, dan metrik

**Tujuan v1**

1. Satu goal di chat menghasilkan aplikasi yang berjalan. Manusia hanya terlibat di dua gerbang: persetujuan brief dan persetujuan merge.
2. Setiap peran agent dapat diatur provider (subscription) dan modelnya.
3. Semua artefak tersimpan dan bisa ditelusuri: brief, plan, task, log, dan review.
4. Pemakaian kuota tersebar antar subscription, dengan fallback otomatis saat satu provider kena limit.

**Non-tujuan v1**

- Bukan SaaS, bukan multi-user, dan tidak berjalan di cloud.
- Tidak memanggil API model secara langsung dan tidak memakai ulang token OAuth milik CLI. Yang dijalankan hanya binary CLI resmi.
- Bukan IDE atau editor kode.
- Tidak melakukan deploy ke production.

**Metrik keberhasilan** (target usulan, dikalibrasi ulang setelah 10 proyek pertama)

| Metrik | Target v1 |
| --- | --- |
| Task lolos review dalam maksimal 2 putaran tanpa intervensi manual | ≥ 70% |
| Waktu dari goal pertama sampai plan disetujui | ≤ 15 menit |
| Run gagal karena error orkestrator (bukan karena agent) | < 5% |
| Task gagal karena limit kuota padahal ada provider cadangan | 0 |

## Pengguna dan skenario utama

**Pengguna utama:** solo builder atau developer senior yang punya dua sampai tiga subscription coding agent dan membangun produk sendiri. **Pengguna kedua:** tech lead tim kecil yang memakai agent untuk prototyping dan mengerjakan fitur.

| Skenario | Masukan pengguna | Hasil yang diharapkan |
| --- | --- | --- |
| Aplikasi baru dari nol | Goal umum, misalnya “aplikasi absensi berbasis barcode dengan notifikasi WhatsApp” | Repo baru berisi aplikasi yang berjalan, test, dan README |
| Fitur baru di repo yang sudah ada | Path repo + deskripsi fitur | Branch berisi fitur, lolos test yang sudah ada maupun test baru |
| Bugfix atau refactor terarah | Deskripsi bug atau target refactor | Perubahan kecil yang sudah direview, lengkap dengan test regresi |
| Melanjutkan proyek setelah jeda | Membuka proyek lama di DALANG | State, plan, dan task tersisa dipulihkan, lalu pekerjaan dilanjutkan |

## Alur produk: D-A-L-A-N-G

&#91;embedded content: alur DALANG · 6 langkah, 2 gerbang persetujuan\]

Pengguna hanya turun tangan di Agree dan Guard. Diskusi bisa berlangsung beberapa putaran, dan task yang gagal review kembali ke coder sebelum sampai ke pengguna.

## Kebutuhan fungsional

P0 = wajib ada di v1, P1 = sebaiknya ada di v1, P2 = sesudah v1.

| ID | Modul | Kebutuhan | Prioritas |
| --- | --- | --- | --- |
| F-01 | Proyek | Membuat proyek baru (folder kosong + `git init`) atau membuka repo yang sudah ada | P0 |
| F-02 | Proyek | Menyimpan `PROJECT.md` (stack, konvensi, struktur folder) lalu membuat symlink ke `CLAUDE.md` dan `AGENTS.md` | P0 |
| F-03 | Discuss | Chat dengan agent Lead, dengan sesi CLI yang tetap tersambung lintas giliran (resume session id) | P0 |
| F-04 | Discuss | Lead mengirim pertanyaan terstruktur, dan UI menampilkannya sebagai kartu berisi opsi pilihan serta isian bebas | P0 |
| F-05 | Discuss | Pengguna bisa menekan “cukup, buat brief” kapan saja untuk menghentikan sesi tanya-jawab | P1 |
| F-06 | Agree | Lead menyusun brief: scope, fitur, stack, batasan, dan hal yang di luar scope. Brief ditampilkan sebagai dokumen yang bisa diedit. | P0 |
| F-07 | Agree | Tombol Revisi (dengan catatan untuk Lead) dan Setuju. Brief yang disetujui dikunci dan diberi nomor versi. | P0 |
| F-08 | List | Lead memecah brief menjadi milestone dan task. Setiap task berisi tujuan, file yang boleh disentuh, file referensi, acceptance criteria, perintah verifikasi, role, dan complexity. | P0 |
| F-09 | List | Task bertanda `needs_split` dipecah ulang secara otomatis oleh Lead, maksimal 2 tingkat | P1 |
| F-10 | List | Kanban board: edit, hapus, tambah, ubah urutan, ubah dependensi, dan ganti profil agent per task sebelum disetujui | P0 |
| F-11 | Assign | Dispatcher mengambil task yang sudah approved dan semua dependensinya selesai, lalu memilih profil lewat aturan routing | P0 |
| F-12 | Assign | Batas jumlah run paralel per provider | P0 |
| F-13 | Assign | Fallback ke profil cadangan saat provider kena limit, error, atau timeout | P1 |
| F-14 | Navigate | Menjalankan CLI secara headless lewat PTY, dengan log yang di-stream live ke kartu task | P0 |
| F-15 | Navigate | Git commit checkpoint sebelum dan sesudah setiap run, sehingga rollback bisa dilakukan satu klik | P0 |
| F-16 | Navigate | Satu git worktree per task untuk task yang file-nya tidak beririsan | P1 |
| F-17 | Navigate | Tombol stop, ulangi, dan lanjutkan untuk setiap run | P0 |
| F-18 | Guard | Reviewer menjalankan perintah verifikasi dan menulis `review.json`. Jika gagal, temuan dikirim balik ke coder (maksimal 2 putaran). | P0 |
| F-19 | Guard | Tampilan diff per task beserta ringkasan review, dengan tombol approve merge atau tolak | P0 |
| F-20 | Guard | Langkah integrasi setelah merge: menjalankan seluruh test suite di branch utama | P1 |
| F-21 | Settings | CRUD agent profile: provider, model, effort, prompt peran, mode izin, timeout | P0 |
| F-22 | Settings | Halaman status provider: CLI mana yang terpasang, versinya, dan status login | P0 |
| F-23 | Riwayat | Arsip semua run: prompt, output, durasi, profil yang dipakai, dan hasil | P0 |
| F-24 | Riwayat | Statistik pemakaian per provider (jumlah run, durasi, kejadian limit) | P1 |
| F-25 | Notifikasi | Notifikasi browser saat gerbang manusia menunggu keputusan atau saat pipeline gagal | P2 |

## Agent profile, provider, dan routing

**Provider** (subscription/CLI mana yang dipakai) dan **model** adalah dua pengaturan yang terpisah. Satu provider bisa menyediakan beberapa model. Misalnya, Antigravity juga menyediakan model non-Gemini melalui flag model, sehingga bisa dipakai sebagai cadangan lintas subscription.

**Field agent profile**

| Field | Contoh | Keterangan |
| --- | --- | --- |
| `name` | `coder-small` | Nama unik profil |
| `provider` | `codex` | Salah satu dari `claude-code`, `codex`, `antigravity` |
| `model` | isian bebas + saran | Tidak di-hardcode, karena daftar model berubah-ubah dan bergantung pada tier subscription |
| `effort` | `low` / `medium` / `high` | Diterjemahkan ke flag masing-masing CLI jika didukung |
| `role_prompt` | file `prompts/coder.md` | Instruksi peran yang ditambahkan ke setiap brief task |
| `permission_mode` | `workspace-write` | Batas izin: hanya boleh menulis di dalam workspace |
| `timeout` / `idle_timeout` | 30 menit / 3 menit | Proses dimatikan jika melewati batas |
| `max_parallel` | 2 | Batas run bersamaan untuk profil ini |

**Contoh aturan routing** (aturan pertama yang cocok yang dipakai)

```yaml
routing:
  - { role: lead,                        profile: lead }
  - { role: engineer, complexity: low,   profile: coder-small, fallback: coder-heavy }
  - { role: engineer, complexity: high,  profile: coder-heavy, fallback: lead }
  - { role: qa,                          profile: reviewer,    fallback: planner }
```

**Adapter per provider** (flag pasti diverifikasi terhadap `--help` saat implementasi)

| Provider | Perintah headless | Pemilihan model | Catatan |
| --- | --- | --- | --- |
| Claude Code | `claude -p --output-format stream-json` | `--model` | Percakapan Lead dilanjutkan lewat `--resume <session_id>` |
| Codex | `codex exec --json` | `-m`, `-c model_reasoning_effort=…` | Izin lewat `--sandbox workspace-write` atau `--full-auto` |
| Antigravity | `agy --output-format stream-json --mode accept-edits -p='<prompt>'` | `--model` | Tanpa PTY bekerja normal (teruji di v1.5.10). Prompt wajib ditempel ke flag (`-p='...'`), karena `-p` memakai argumen berikutnya sebagai prompt. **Tidak membatasi tulis ke luar workspace**, wajib dibungkus sandbox (lihat Hasil validasi CLI). |

**Resume, ID sesi, dan output terstruktur** (teruji)

| Provider | ID sesi diambil dari | Resume | Output sesuai skema |
| --- | --- | --- | --- |
| Claude Code | `session_id` di setiap event | `--resume <id>` | `--json-schema '<json>'` → `structured_output` |
| Codex | `thread_id` di event `thread.started` | `codex exec resume <id> --json` | `--output-schema file.json -o out.json` |
| Antigravity | `conversation_id` di event `result` | `--conversation <id>` | `--json-schema file.json` → `result.structured_output` |

Semua adapter wajib menutup stdin (`/dev/null`). Tanpa itu Codex menunggu input dan macet. Parser mengabaikan event yang tidak dikenal.

Aturan desain: model terkuat dipakai untuk Lead dan reviewer, model ringan untuk coder task kecil. Reviewer sebaiknya memakai provider yang berbeda dari coder pada task yang sama (cross-model review).

## Kontrak output agent

Semua keputusan orkestrator diambil dari file JSON yang ditulis agent ke `.dalang/`, bukan dari teks bebas di stdout. Setiap file divalidasi dengan skema Zod. Jika tidak valid, agent diminta mengulang maksimal 2 kali, dengan pesan error validasi disertakan.

| Tipe | Ditulis oleh | File | Isi utama |
| --- | --- | --- | --- |
| `questions` | Lead | `.dalang/discuss/round-N.json` | Daftar pertanyaan, opsi jawaban, dan alasan setiap pertanyaan |
| `brief` | Lead | `.dalang/brief.v{n}.json` | Ringkasan, fitur, stack, batasan, di luar scope, asumsi |
| `plan` | Lead | `.dalang/plan.json` | Milestone dan daftar task (skema di bawah) |
| `task_result` | Coder | `.dalang/tasks/{id}/result.json` | Status, file yang diubah, catatan, hambatan |
| `review` | Reviewer | `.dalang/tasks/{id}/review.json` | `pass`/`fail`, hasil perintah verifikasi, temuan per tingkat keparahan |

**Skema task** (bagian dari `plan`)

```json
{
  "id": "T-007",
  "title": "Endpoint POST /attendance/scan",
  "milestone": "M2",
  "role": "engineer",
  "complexity": "low",
  "depends_on": ["T-003", "T-005"],
  "goal": "Mencatat kehadiran dari hasil scan barcode",
  "files_allowed": ["src/attendance/**"],
  "files_reference": ["src/db/schema.ts", "PROJECT.md"],
  "acceptance_criteria": [
    "Barcode valid menghasilkan 201 dan satu baris kehadiran",
    "Scan ganda di hari yang sama menghasilkan 409"
  ],
  "verify": "pnpm test src/attendance",
  "needs_split": false
}
```

**Skema review**

```json
{
  "task_id": "T-007",
  "status": "fail",
  "verify_exit_code": 1,
  "findings": [
    { "severity": "critical", "file": "src/attendance/scan.ts", "note": "Scan ganda tidak dicek" }
  ]
}
```

## Kebutuhan non-fungsional dan keamanan

| Area | Kebutuhan |
| --- | --- |
| Akses jaringan | Server hanya di-bind ke `127.0.0.1`. Akses dari luar mesin dimatikan secara default. |
| Kredensial | DALANG tidak menyimpan API key maupun token. Autentikasi sepenuhnya memakai login CLI resmi milik pengguna. |
| Isolasi | Agent hanya boleh menulis di dalam folder proyek. Setiap CLI dijalankan lewat pembungkus sandbox `bwrap` (folder proyek read-write, sistem file lain read-only, `/tmp` terpisah). P0 di Linux; macOS lewat `sandbox-exec` (P1). Mode container Docker tetap opsi (P2). Prompt pembatas dipakai sebagai lapisan tambahan, bukan satu-satunya pagar. |
| Keandalan | State pipeline disimpan ke SQLite setiap kali berpindah langkah. Setelah crash atau restart, pipeline dilanjutkan dari langkah terakhir yang selesai. |
| Batas waktu | Ada timeout total dan idle-timeout per run. Proses yang macet dimatikan dan task ditandai gagal beserta alasannya. |
| Observabilitas | stdout/stderr setiap run disimpan ke `.dalang/logs/` dan bisa diputar ulang di UI. |
| Responsivitas | Log tampil di UI kurang dari 1 detik setelah ditulis oleh CLI. |
| Platform | Linux dan macOS (P0), Windows lewat ConPTY (P1). |
| Kepatuhan | Hanya menjalankan binary CLI resmi. Tidak mengekstrak token OAuth dan tidak memanggil backend provider secara langsung. |
| Instalasi | Cukup satu perintah: `npx dalang` menyalakan server dan membuka browser. |

## Arsitektur dan stack teknologi

&#91;embedded content: arsitektur DALANG · UI, server, CLI, workspace\]

**Keputusan: satu instance DALANG global untuk banyak proyek**, bukan satu instance per proyek. Alasannya, kuota subscription dipakai bersama lintas proyek, sehingga batas paralel per provider (F-12), fallback limit (F-13), dan statistik (F-24) harus melihat semua proyek sekaligus. Login CLI juga bersifat per pengguna, bukan per proyek.

| Lokasi | Isi |
| --- | --- |
| `~/.dalang/` (global) | SQLite: indeks proyek, session, agent profile, routing, `provider_event`, statistik |
| `<repo>/.dalang/` (per proyek) | Brief, plan, task, log, review, ikut ter-versi di git. Proyek tetap portabel dan bisa dibuka tanpa DALANG |

Satu proses server melayani semua proyek. Setiap run dibungkus sandbox dengan folder proyeknya sendiri. Override routing atau profil per proyek disimpan di `<repo>/.dalang/config`, dan menang atas pengaturan global.

Browser hanya berkomunikasi dengan server lokal. Server menjalankan CLI resmi, dan CLI itulah yang menulis ke workspace. Pilihan stack didasarkan pada kebutuhan inti tool: subprocess, PTY, streaming, dan validasi JSON.

| Lapisan | Pilihan | Alasan |
| --- | --- | --- |
| Bahasa | TypeScript end-to-end | Skema task dan output agent ditulis sekali, lalu dipakai bersama oleh UI dan server |
| Runtime | Node.js 22 LTS | Subprocess dan streaming matang di Node. `node-pty` hanya opsional (tampilan terminal live), karena ketiga CLI jalan tanpa TTY |
| Server | Fastify + WebSocket | Ringan, cocok untuk proses panjang dan streaming log |
| Frontend | React + Vite + shadcn/ui + TanStack Query | Chat, kanban, dan diff viewer cepat dirakit |
| Database | SQLite + Drizzle ORM | Satu file, tanpa server database |
| Validasi | Zod | Output agent divalidasi sebelum dipakai untuk keputusan |
| Antrian | p-queue (di dalam proses) | Batas paralel per provider tanpa perlu Redis |
| Git | simple-git + `git worktree` | Commit checkpoint dan isolasi per task |
| Distribusi | Monorepo pnpm, dirilis ke npm | `npx dalang` menyalakan server dan membuka browser |

## Hasil validasi CLI (18 Nov 2026)

Diuji di Linux dengan Claude Code (login aktif), Codex 0.169.0, dan agy 1.5.10, semuanya headless tanpa TTY.

| Uji | Claude | Codex | agy |
| --- | --- | --- | --- |
| Headless dengan return JSON | ✅ | ✅ | ✅ (±3–17 detik/turn) |
| Menulis file ke `.dalang/` | ✅ | ✅ | ✅ |
| Resume lintas giliran | ✅ | ✅ | ✅ |
| Output sesuai JSON schema | ✅ | ✅ | ✅ |
| Menolak tulis di luar folder proyek | ✅ | ✅ (tetapi `/tmp` boleh) | ❌ |
| Menolak tulis di luar saat dibungkus `bwrap` | tidak diuji | tidak diuji | ✅ |
| Pemakaian/limit terbaca sebelum run | ✅ `claude -p "/usage"` (teks: % sesi 5 jam dan mingguan + waktu reset) | ✅ JSON-RPC `account/rateLimits/read` ke `codex app-server` lewat stdio (`usedPercent`, `windowDurationMins`, `resetsAt`, `rateLimitReachedType`, `planType`) | ✅ `agy -p="/usage"` (tabel teks: sisa % 5 jam dan mingguan per kelompok model + waktu reset) |
| Pemakaian/limit terbaca saat run | ✅ event `rate_limit_event` di stream | ⚠️ hanya di file sesi `~/.codex/sessions/**/*.jsonl` | ❌ tidak ada di stream |

Catatan implementasi:

- `bwrap` yang teruji: `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind $PROJECT $PROJECT --bind $HOME/.gemini $HOME/.gemini --chdir $PROJECT <cli> ...`. Penulisan ke luar ditolak, penulisan di dalam proyek tetap jalan. Pembacaan file lain tetap terbuka (mis. `~/.ssh`); untuk menutupnya, pakai daftar bind eksplisit.
- Claude: `--bare` tidak dipakai karena melewati login keychain. Gunakan `--setting-sources project --strict-mcp-config --disable-slash-commands` (cache konteks turun dari ±121k ke ±28k token).
- Setting pengguna agy (`~/.gemini/antigravity-cli/settings.json`) berisi `allowNonWorkspaceAccess: true`; menimpanya lewat `--settings` tidak mengubah perilaku.
- Daftar model agy didapat dari `agy models` (bisa dipakai untuk saran model di agent profile).
- Belum teruji: perilaku saat limit benar-benar tercapai (pesan error dan exit code di ketiga CLI), pertanyaan interaktif agy (`ask_question`) di mode headless, serangan prompt injection terhadap prompt pembatas, `bwrap` pada Claude dan Codex.

## Model data

SQLite menyimpan state dan indeks, sedangkan isi lengkap artefak (brief, plan, log, review) tetap berupa file di `.dalang/` agar ikut ter-versi di git.

| Entitas | Field utama | Relasi |
| --- | --- | --- |
| `project` | id, nama, path, branch utama, dibuat | punya banyak `session`, `task` |
| `session` | id, project\_id, fase (discuss/agree/list/run), cli\_session\_id | punya banyak `message` |
| `message` | id, session\_id, peran (user/lead), tipe (teks/questions/brief), isi, waktu | — |
| `brief` | id, project\_id, versi, status (draft/disetujui), path file | satu `brief` disetujui → satu `plan` |
| `plan` | id, brief\_id, versi, path file | punya banyak `task` |
| `task` | id, plan\_id, judul, role, complexity, status, profile\_override, putaran\_review | `task_dependency`, banyak `run` |
| `task_dependency` | task\_id, depends\_on\_id | — |
| `run` | id, task\_id, profile\_id, provider, model, mulai, selesai, exit\_code, alasan\_gagal, commit\_sebelum, commit\_sesudah, path log | satu `review` (untuk run coder) |
| `review` | id, run\_id, status, path file | — |
| `agent_profile` | id, nama, provider, model, effort, role\_prompt, permission\_mode, timeout, max\_parallel | dipakai `routing_rule` dan `run` |
| `routing_rule` | id, urutan, role, complexity, profile\_id, fallback\_profile\_id | — |
| `provider_event` | id, provider, tipe (rate\_limit/error/login\_expired), waktu | untuk statistik dan fallback |

## Rencana rilis bertahap

Setiap fase harus sudah berguna dengan sendirinya sebelum fase berikutnya dimulai.

| Fase | Cakupan | Kriteria selesai |
| --- | --- | --- |
| v0.1 — Rembuk | Proyek, chat Lead (Discuss), brief (Agree), generate plan dan kanban (List), halaman status provider. Belum ada eksekusi. | Dari satu goal dihasilkan brief dan plan valid yang lolos skema, untuk 3 contoh proyek |
| v0.2 — Jalan | Eksekusi sekuensial satu task per waktu, adapter ketiga CLI, PTY, log live, commit checkpoint, stop/ulangi | Satu aplikasi CRUD kecil selesai end-to-end tanpa membuka CLI secara manual |
| v0.3 — Kawal | Reviewer dan loop perbaikan, tampilan diff, approve merge, test integrasi, agent profile dan routing di UI | ≥ 70% task lolos review dalam maksimal 2 putaran pada 5 proyek uji |
| v0.4 — Paralel | Worktree per task, dependency graph, batas paralel per provider, fallback kuota, statistik pemakaian | Dua task independen berjalan bersamaan tanpa konflik; limit kuota otomatis dialihkan ke profil cadangan |
| v1.0 | Penyempurnaan, dukungan Windows, dokumentasi, rilis npm | Dipakai sendiri untuk membangun 10 proyek nyata |

## Risiko, mitigasi, dan pertanyaan terbuka

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Pemecahan task oleh Lead buruk (terlalu besar, kriteria kabur) | Coder melenceng, review terus gagal | Skema task yang ketat, aturan `needs_split`, dan contoh plan yang baik di prompt Lead |
| Flag atau format output CLI berubah saat update | Adapter rusak | Adapter dipisah per provider, versi CLI dicek saat startup, dan ada smoke test per adapter |
| ~~`agy` tidak mengeluarkan output tanpa TTY~~ | Tidak terbukti di agy 1.5.10 | Tetap pasang idle-timeout, dan smoke test per adapter |
| `agy` menulis di luar folder proyek (teruji, bahkan dengan `--sandbox` dan `--settings`) | Kerusakan file di luar repo yang tidak muncul di `git diff` | Pembungkus `bwrap` pada semua adapter (teruji menahan), ditambah prompt pembatas |
| Agent mengubah file di luar scope | Kerusakan kode atau sistem | `files_allowed` dicek dari diff setelah run, commit checkpoint, sandbox `bwrap`, mode izin workspace-write. Catatan: Codex `workspace-write` tetap boleh menulis di `/tmp`. |
| Format pembacaan limit berbeda per CLI dan bisa berubah (`/usage` Claude dan agy berupa teks, Codex lewat `app-server` yang berstatus experimental) | Pembacaan kuota proaktif (F-13) rusak saat CLI update | Satu adapter `getUsage()` per provider yang menghasilkan bentuk seragam `{window, usedPercent, resetsAt}`, dengan smoke test. Jika gagal dibaca, anggap tidak diketahui dan pakai deteksi reaktif dari teks error/exit code |
| Limit kuota habis di tengah pipeline | Pipeline berhenti | Deteksi pesan limit, fallback ke profil cadangan, atau jeda dan lanjutkan otomatis |
| Konflik merge saat task berjalan paralel | Merge gagal | Paralel hanya untuk task yang file-nya tidak beririsan; konflik dikirim ke task integrasi |
| Konteks antar agent tidak sinkron | Gaya dan konvensi kode tidak konsisten | Satu `PROJECT.md` bersama, brief per task, dan reviewer mengecek konvensi |

**Pertanyaan terbuka**

- [ ] Apakah Lead boleh mengubah `PROJECT.md` sendiri, atau perubahan harus lewat persetujuan pengguna?
- [ ] Berapa batas default putaran review sebelum task dikembalikan ke pengguna: 2 atau 3?
- [ ] Apakah langkah testing perlu agent QA terpisah, atau cukup reviewer yang menjalankan perintah `verify`?
- [ ] Apakah DALANG dirilis open source? Jika ya, lisensi apa?
- [ ] Format notifikasi untuk gerbang manusia: cukup notifikasi browser, atau juga Telegram/WhatsApp?
