# QuidChat

[English](../../README.md) · **Bahasa Indonesia** · [Bahasa Melayu](README.ms.md) · [中文](README.zh.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Asisten chat yang bisa ditanyai pelanggan tentang **produk dan layanan Anda sendiri** — dan tidak pernah mengarang.

Setiap pernyataan tentang bisnis Anda berasal dari dokumen yang Anda berikan, dan asisten menunjukkan dokumen mana. Kalau tidak ada sumbernya, ia mengatakannya, bukan menebak.

Pasang di situs Anda dengan satu tag `<script>`. WhatsApp, Telegram, Discord, Slack dan LINE memakai inti yang sama.

> Halaman ini memuat semua yang dibutuhkan untuk menjalankan dan mengelola QuidChat. Untuk bagian yang lebih dalam — cara isolasi antar-tenant bekerja, cara pencarian disusun, keputusan penyimpanan — lihat [README bahasa Inggris](../../README.md), yang menjadi rujukan lengkapnya.

---

## Mulai cepat

```bash
pnpm install
pnpm build

export OPENAI_API_KEY=sk-...

# Buat satu bisnis, dan izinkan situs tempat widget akan dipasang
node packages/cli/dist/main.mjs init toko-saya \
  --name "Toko Saya" \
  --origin https://tokosaya.example

# Beri sesuatu untuk dijawab
cat kebijakan.txt | node packages/cli/dist/main.mjs add-text toko-saya \
  --title "Kebijakan Toko" --stdin

# Atau arahkan ke halaman yang sudah Anda punya
node packages/cli/dist/main.mjs add-url toko-saya https://tokosaya.example/pengiriman \
  --title "Ketentuan pengiriman"

# Atau baca seluruh situs — bisa juga dari panel, di menu Pengetahuan
node packages/cli/dist/main.mjs add-site toko-saya https://tokosaya.example --max-pages 25

node packages/cli/dist/main.mjs serve
```

Panel admin ada di **http://localhost:3210/panel** — semua konfigurasi ada di sana, termasuk yang di atas dilewatkan sebagai flag. Panelnya tersedia dalam sepuluh bahasa dan mengikuti bahasa peramban Anda. Itu bahasa panel, terpisah dari bahasa yang dibaca pelanggan Anda, yang diatur per bisnis di Pengaturan → Widget.

Lalu tempel ini ke situs yang tadi Anda izinkan:

```html
<script src="http://localhost:3210/quidchat.js"
        data-quidchat-tenant="toko-saya"
        defer></script>
```

Tanyakan sesuatu yang ada di dokumen Anda, dan jawabannya datang lengkap dengan nama dokumennya.

## Kenapa jawabannya bisa dipercaya

Model tidak pernah menjawab dari ingatannya sendiri tentang bisnis Anda. Setiap kalimat yang menyebut fakta tentang toko Anda harus menunjuk ke potongan dokumen yang Anda unggah; kalau tidak bisa, jawabannya ditolak sebelum sampai ke pelanggan, dan asisten mengatakan bahwa informasinya belum ada.

Topik berisiko tinggi — harga, diskon, garansi, pengembalian dana, ketentuan hukum, stok — tidak pernah dijawab dari kesimpulan sendiri. Hanya dari kalimat yang memang tertulis di dokumen Anda.

Pertanyaan yang ditolak masuk ke layar **Belum terjawab**. Di situ Anda membaca pertanyaan asli pelanggan dan menulis jawabannya sekali; pelanggan berikutnya yang bertanya hal serupa langsung mendapat jawaban itu.

## Memberi pengetahuan

Empat cara, semuanya dari panel di menu **Pengetahuan**:

- **Tempel teks** — cara tercepat. Kebijakan toko, daftar harga, jam buka.
- **Satu halaman web** — dibaca sekali, dan bisa dibaca ulang kapan pun halamannya berubah.
- **Seluruh situs** — mengikuti tautan dari satu alamat awal, mematuhi `robots.txt`, sampai 25 halaman sekali jalan. Setiap halaman menjadi sumber tersendiri dengan judulnya sendiri, supaya kutipan yang dilihat pelanggan berbunyi "Ketentuan pengiriman", bukan nama situs Anda.
- **Berkas PDF** — sampai sekitar 9 MB. PDF hasil pindai ditolak beserta alasannya: hurufnya berupa gambar dan perlu OCR dulu.

## Saluran

Widget situs langsung jalan. Sisanya opsional — tanpa kredensial, alamat webhook-nya menjawab `404`, karena bisnis yang hanya memakai widget tidak seharusnya punya endpoint WhatsApp terbuka di servernya.

Arahkan platformnya ke `POST /v1/channels/:channel/:tenantSlug`.

| Saluran | Yang dibutuhkan |
|---|---|
| Telegram | token bot, webhook secret |
| WhatsApp Cloud | phone number id, access token, app secret |
| WAHA (WhatsApp sendiri) | alamat WAHA, nama sesi, API key |
| Discord | bot token, public key |
| Slack | bot token, signing secret |
| LINE | channel access token, channel secret |

Isi kredensialnya di menu **Saluran** pada panel. Semuanya dienkripsi dengan `QUIDCHAT_SECRET_KEY` (`openssl rand -base64 32`) memakai AES-256-GCM, dan panel tidak pernah menampilkan kembali nilai yang tersimpan — bahkan yang disamarkan sekalipun.

Isi juga webhook secret-nya. Verifikasi tanda tangan dijalankan sebelum apa pun diurai atau disimpan, jadi permintaan palsu tidak pernah masuk ke alur — tanpa itu, siapa pun yang tahu alamatnya bisa menyisipkan kalimat ke riwayat percakapan Anda dan menghabiskan anggaran Anda.

Saluran bisa **dijeda** tanpa menghapus kredensialnya, dan jeda itu benar-benar menghentikan jawaban, bukan sekadar mengubah label.

## Mengendalikan biaya

`monthly_budget_cents` adalah batas keras: setelah tercapai, asisten berhenti menjawab, bukan meneruskan tagihan. Nol berarti tanpa batas — bukan nol pengeluaran.

Mode jawaban menentukan biayanya:

- **static** — hanya jawaban siap pakai yang sudah disetujui. Tidak pernah memanggil model, jadi gratis dijalankan.
- **thrifty** — mencari di dokumen Anda dan menjawab dari situ.
- **full** — menulis ulang pertanyaannya lebih dulu, lalu mencari. Menemukan lebih banyak, biayanya lebih besar.

Anda juga bisa memakai model yang berjalan di mesin sendiri lewat Ollama: tanpa kunci, tanpa akun, dan tidak ada data yang keluar dari server Anda. Kalau QuidChat mendeteksi ada model yang sudah berjalan di server yang sama, panel akan menawarkannya.

## Keamanan

- **Isolasi antar-tenant** memakai row-level security di basis data, bukan penyaringan di kode aplikasi.
- **Daftar situs yang diizinkan** menentukan siapa yang boleh membuka widget Anda. Situs yang tidak terdaftar ditolak, dan itulah yang mencegah orang lain menempelkan asisten Anda di situsnya lalu menghabiskan anggaran Anda.
- **Token admin** dibandingkan dengan waktu tetap, dan tebakan yang salah dibatasi per sumber.
- **Panel** menolak dipasang di dalam bingkai situs lain dan hanya menjalankan skripnya sendiri (`script-src 'self'`), karena di situlah token admin disimpan.
- **Kredensial** tidak pernah ditampilkan kembali, dan tidak pernah disimpan sebagai teks biasa.

## Menyimpan dan mencadangkan

`retention_days` menghapus percakapan setelah lewat batasnya. Server menjalankannya saat mulai dan sekali sehari; `quidchat prune` melakukannya sekali lalu keluar, untuk yang ingin memasangnya di cron sendiri.

Kalau seorang pelanggan minta datanya dihapus hari ini, gunakan tombol hapus transkrip di layar **Percakapan** — itu menghapus pesannya, kutipannya, dan catatan pertanyaan yang belum terjawab dari percakapan itu.

`quidchat backup` menulis satu berkas berisi semuanya: dokumen, jawaban yang Anda setujui, dan setiap percakapan pelanggan. Ia mengambil salinan lewat mesin basis data yang sedang berjalan, bukan menyalin direktori — menyalin berkas yang sedang dipakai Postgres adalah cara sebuah cadangan menjadi tidak bisa dipulihkan justru saat dibutuhkan. Pada Postgres terkelola, perintahnya mencetak baris `pg_dump` yang perlu Anda jalankan.

## Konfigurasi

| Variabel | Bawaan | Artinya |
|---|---|---|
| `PORT` | `3210` | `0` meminta port bebas ke sistem |
| `DATABASE_URL` | — | Postgres terkelola. Kalau kosong, memakai PGlite tertanam |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | Tempat PGlite menyimpan data. `memory` untuk sementara |
| `QUIDCHAT_ADMIN_TOKEN` | — | Wajib untuk API admin; kalau kosong, semua rute admin menolak |
| `QUIDCHAT_SECRET_KEY` | — | 32 byte, base64 atau hex. Mengenkripsi kredensial yang disimpan di panel |
| `QUIDCHAT_LOG` | `text` | Satu baris per permintaan. `json` untuk pengurai log, `off` untuk mematikan |

Selebihnya diatur di panel: model, mode jawaban, anggaran, retensi, topik berisiko, situs yang diizinkan, dan tampilan widget.

## Lisensi

MIT. Lihat [README bahasa Inggris](../../README.md) untuk rincian pengembangan, struktur paket, dan cara berkontribusi.
