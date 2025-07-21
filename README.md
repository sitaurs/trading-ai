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

## Alur Kerja Sistem

1. **Inisialisasi** – `index.js` memuat variabel dari `.env`, membaca daftar penerima (`config/recipients.json`), dan memulai koneksi WhatsApp.
2. **Analisis Terjadwal** – Modul `analysisHandler` dijadwalkan menggunakan `node-cron` untuk mengeksekusi analisis DXY dan semua pair yang didukung tiap jam. Hasil analisis serta gambar chart dikirim via WhatsApp.
3. **Pengambilan Keputusan** – Teks analisis naratif dari Gemini diekstraksi oleh modul `extractor` menjadi struktur data (`pair`, `arah`, `sl`, `tp`, dan sebagainya). Modul `decisionHandlers` mengeksekusi keputusan:
   - **OPEN** – memanggil API broker untuk membuka order, menyimpan data ke folder `pending_orders/` atau `live_positions/` dan mencatat jurnal awal.
   - **CLOSE_MANUAL** – menutup atau membatalkan order yang ada melalui broker, lalu menuliskannya ke jurnal.
   - **HOLD/NO_TRADE** – hanya mengirim notifikasi tanpa aksi trading.
4. **Monitoring** – `monitoringHandler` berjalan periodik memeriksa apakah pending order berubah menjadi posisi live atau apakah posisi live telah tertutup. Jika posisi tertutup, modul ini mengambil detail profit melalui broker dan memanggil `journalingHandler` untuk mencatatnya.
5. **Journaling** – Data trading yang selesai akan dicatat ke Google Sheets menggunakan kredensial Service Account, lalu file terkait dibersihkan. Modul ini juga berinteraksi dengan `circuitBreaker` untuk menghitung kemenangan dan kekalahan berturut-turut.
6. **Circuit Breaker** – Jika kerugian beruntun melebihi batas (`MAX_CONSECUTIVE_LOSSES` di `modules/circuitBreaker.js`), modul ini akan menahan eksekusi analisis selanjutnya hingga hari berikutnya.

## Perintah WhatsApp

Bot menerima beberapa perintah teks. Berikut ringkasannya:

- `/menu` atau `/help` – Menampilkan menu bantuan.
- `/status` – Ringkasan status bot dan posisi saat ini.
- `/dxy` – Analisis khusus indeks dolar.
- `/<pair>` (misal `/usdjpy`) – Meminta analisis instan untuk pair tersebut.
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

