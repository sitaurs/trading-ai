# Trading AI Bot

**Trading AI Bot** adalah sistem otomatis berbasis Node.js yang mengintegrasikan analisis pasar menggunakan Google Gemini, pengiriman notifikasi melalui WhatsApp, serta eksekusi trading melalui API broker kustom. Proyek ini dirancang sebagai contoh lengkap bagaimana membangun pipeline analisis sampai eksekusi trading secara otomatis.

## Fitur Utama

- Analisis naratif dengan model Google Gemini.
- Pengambilan gambar chart dari Chart-Img API.
- Integrasi WhatsApp untuk menerima perintah dan mengirim notifikasi.
- Eksekusi order (buka, tutup, modifikasi) melalui endpoint API broker.
- Monitoring otomatis status order dan posisi.
- Pencatatan hasil trading ke Google Sheets.
- Circuit Breaker untuk membatasi kerugian beruntun.
- Dukungan penjadwalan analisis otomatis.

## Struktur Direktori

- `index.js` – titik masuk utama.
- `modules/` – berisi modul-modul fungsional seperti handler analisis, broker, WhatsApp, monitoring, dan journaling.
- `config/` – menyimpan file status serta kredensial Google.
- `prompts/` – template prompt yang digunakan ketika berinteraksi dengan AI.
- `pending_orders/`, `live_positions/`, `journal_data/` – direktori ini dibuat otomatis saat bot berjalan untuk menyimpan data sementara.
- `analysis_cache/` – cache hasil analisis DXY.
- `src/utils/` – utilitas seperti perhitungan ATR dan validasi sesi trading.
- `tests/` – skrip pengujian sederhana untuk beberapa utilitas.

## Persyaratan

- Node.js 18+.
- Akses internet untuk menghubungi API eksternal.
- Akun Google dengan API key Gemini dan kredensial Service Account untuk Google Sheets.
- API key untuk layanan chart-img.com.
- Endpoint dan API key broker trading yang kompatibel.

## Instalasi

1. **Klon repositori dan masuk ke direktori proyek**
   ```bash
   git clone https://github.com/sitaurs/trading-ai
   cd trading-ai
   ```
2. **Pasang dependensi Node.js**
   ```bash
   npm install
   ```
3. **Salin berkas `.env.example` menjadi `.env`** dan sesuaikan nilainya.
   ```bash
   cp .env.example .env
   ```
4. **Siapkan kredensial Google** di `config/google-credentials.json` (format Service Account).

## Konfigurasi `.env`

Berikut penjelasan singkat setiap variabel pada file `.env`:

| Variabel | Deskripsi |
| --- | --- |
| `GEMINI_API_KEY` | API key Google Gemini untuk analisis AI. |
| `CHART_IMG_KEY_1..N` | Satu atau beberapa API key untuk chart-img.com. Bot akan berputar menggunakan key-key ini. |
| `MY_WHATSAPP_ID` | ID WhatsApp milik Anda (format `62xxxxxxxxxx@s.whatsapp.net`). |
| `SUPPORTED_PAIRS` | Daftar pair yang diizinkan, dipisah koma. Contoh: `USDJPY,USDCHF,GBPUSD`. |
| `NOTIFICATION_RECIPIENTS` | Daftar ID WA penerima notifikasi otomatis. |
| `ALLOWED_GROUP_IDS` | (Opsional) ID grup WA yang diperbolehkan mengirim perintah. |
| `ENABLE_NEWS_SEARCH` | `true`/`false` untuk mengaktifkan pencarian berita ekonomi otomatis. |
| `GOOGLE_SHEET_ID` | ID spreadsheet tujuan untuk jurnal trading. |
| `BROKER_API_BASE_URL` | URL dasar endpoint API broker MT5. |
| `BROKER_API_KEY` | API key broker untuk otentikasi. |
| `MONITORING_INTERVAL_MINUTES` | Interval pengecekan status posisi secara otomatis. |
| `TRADE_VOLUME` | Besaran lot ketika membuka posisi. |
| `TRADING_SESSIONS` | Range jam trading (WIB) yang diperbolehkan, contoh `14:00-23:00,19:00-04:00`. |
| `ENABLE_LATE_NY` | Jika `true`, trading sesi New York larut malam diperbolehkan. |
| `SWEEP_ATR_MULTIPLIER` | Batas minimal panjang wick dibanding ATR pada filter awal. |
| `MIN_BODY_RATIO` | Rasio body candle minimal terhadap range. |
| `SWING_LOOKBACK` | Lookback bar untuk pengecekan swing break. |
| `LOG_LEVEL` | Tingkat verbosity log (`ERROR`, `WARN`, `INFO`, `DEBUG`). |

Sesuaikan variabel di atas sesuai dengan lingkungan dan broker Anda. Apabila endpoint API broker berubah, cukup ubah `BROKER_API_BASE_URL` pada `.env` kemudian jalankan ulang bot.

## Menjalankan Bot

Setelah konfigurasi selesai, jalankan perintah berikut:

```bash
npm start
```

Saat pertama kali dijalankan, terminal akan menampilkan QR code yang perlu dipindai menggunakan aplikasi WhatsApp Anda. Setelah tersambung, bot siap menerima perintah.

Pengujian unit sederhana dapat dijalankan dengan:

```bash
npm test
```

### Menjalankan dengan PM2

Untuk menjalankan bot secara permanen di latar belakang Anda dapat memakai [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start index.js --name trading-bot
pm2 logs trading-bot     # melihat log
pm2 startup              # jika ingin autostart saat boot
pm2 save
```

## Alur Kerja Trading AI Bot (Dimulai dari Jadwal)

Alur berikut terjadi otomatis setiap jam berkat `node-cron` di `index.js`.

**Tahap 1: Pemicu Jadwal & Pemeriksaan Awal**

1. `runScheduledAnalysis` dipanggil pada waktunya dan mengecek `config/bot_status.json`. Jika `isPaused` bernilai `true`, siklus dilewati.
2. Bot mengirim pesan pembuka ke seluruh penerima terdaftar.

**Tahap 2: Analisis Konteks Pasar (DXY)**

3. Fungsi `analyzeDXY` mengambil gambar chart DXY dari `chart-img.com` dan mengirim prompt ke Gemini.
4. Sentimen DXY disimpan pada `analysis_cache/last_result_DXY.json` dan dikirim ke pengguna.

**Tahap 3: Analisis Setiap Pair**

5. Bot melakukan perulangan untuk setiap pair di `.env` dan melewati `hardFilter.js` untuk validasi volatilitas.
6. Data chart, OHLCV, hasil analisis DXY, sesi pasar, serta berita ekonomi harian dari `analysis_cache/daily_news.json` (diambil sekali per hari) digabung ke dalam `prompt_new_analysis.txt`.
7. Gemini mengembalikan analisis naratif berikut keputusan trading.

**Tahap 4: Eksekusi Keputusan**

8. `extractor.js` mengubah teks naratif menjadi JSON dan `decisionHandlers.js` mengeksekusi hasilnya:
   - Membuka posisi via broker jika keputusan `OPEN`.
   - Menutup posisi bila `CLOSE_MANUAL`.
   - Atau hanya mengirim notifikasi bila `HOLD`/`NO_TRADE`.

**Tahap 5: Monitoring & Jurnal**

9. `monitoringHandler.js` memeriksa perubahan status pending order maupun posisi live.
10. Ketika posisi selesai, `journalingHandler.js` mencatat hasil ke Google Sheets dan memperbarui statistik `circuitBreaker`.

Siklus ini berulang setiap jadwal sehingga bot dapat beroperasi secara otomatis sepanjang hari.

## Perintah WhatsApp

Bot menerima beberapa perintah teks. Berikut ringkasannya:

- `/menu` atau `/help` – Menampilkan menu bantuan.
- `/status` – Ringkasan status bot dan posisi saat ini.
- `/dxy` – Analisis khusus indeks dolar.
- `/<pair>` (misal `/usdjpy`) – Meminta analisis instan untuk pair tersebut.
- `/<pair> force` – Memaksa analisis pair, melewati filter sesi dan hard filter.
- `/news` – Mencari berita ekonomi berdampak tinggi secara manual.
- `/cls <PAIR>` – Menutup posisi atau pending order yang sedang tercatat.
- `/pause` dan `/resume` – Menjeda atau melanjutkan analisis otomatis terjadwal.
- `/profit_today` – Menampilkan total profit/loss hari ini.
- `/add_recipient <ID_WA>` dan `/del_recipient <ID_WA>` – Kelola daftar penerima notifikasi.
- `/list_recipients` – Menampilkan daftar penerima.

Perintah hanya dikenali jika dikirim oleh ID yang terdaftar pada `NOTIFICATION_RECIPIENTS` atau grup yang terdaftar pada `ALLOWED_GROUP_IDS` (jika diisi).

## Catatan Deployment

- Bot menyimpan sesi login WhatsApp pada folder `whatsapp-session/`. Jika ingin mengganti akun, hapus folder tersebut sebelum menjalankan ulang.
- Direktori `pending_orders/`, `live_positions/`, dan `journal_data/` akan dibuat otomatis bila belum ada.
- Jaga keamanan file `.env` dan `config/google-credentials.json` karena berisi data sensitif.
- Apabila koneksi WhatsApp terputus (misalnya muncul kode 515), bot akan mencoba menyambung kembali secara otomatis. Pastikan folder `whatsapp-session/` tidak terhapus agar proses ini berhasil.

## Lisensi

Proyek ini menggunakan lisensi ISC sebagaimana tercantum di `package.json`.

