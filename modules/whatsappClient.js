const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

// Path untuk menyimpan file sesi. Penting agar tidak perlu login berulang kali.
const SESSION_DIR = path.join(__dirname, '..', 'whatsapp-session');

// Memastikan direktori sesi ada
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR);
}

/**
 * Fungsi utama untuk memulai dan mengelola koneksi WhatsApp.
 * @returns {Promise<object>} Instance socket Baileys yang aktif.
 */
async function startWhatsAppClient() {
    // Menggunakan MultiFileAuthState untuk menyimpan kredensial login
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    console.log(`Menggunakan Baileys v${version.join('.')}, Versi Terbaru: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, // Otomatis mencetak QR code di terminal
        browser: ['Trading', 'Chrome', '1.0.0'], // Nama yang akan muncul di "Perangkat Tertaut"
    });

    // Listener untuk menangani update koneksi (QR code, terhubung, terputus, dll.)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'close') {
            const error = new Boom(lastDisconnect?.error)?.output?.statusCode;
            
            console.error('Koneksi terputus karena:', lastDisconnect?.error);

            // Jika error bukan karena logout manual, maka coba sambungkan kembali.
            if (error !== DisconnectReason.loggedOut) {
                console.log('Mencoba menyambungkan kembali...');
                startWhatsAppClient();
            } else {
                console.log('Koneksi ditutup permanen (Logged Out). Hapus folder "whatsapp-session" untuk memulai sesi baru.');
            }
        } else if (connection === 'open') {
            console.log('✅ Koneksi WhatsApp berhasil! Bot siap menerima perintah.');
        }

        // Jika ada QR code baru, tampilkan di terminal (sudah di-handle oleh printQRInTerminal=true)
        // Log ini sebagai cadangan jika ada masalah.
    if (qr) {
        console.log('Pindai QR Code ini dengan aplikasi WhatsApp di ponsel Anda.');
        const qrcode = require('qrcode-terminal'); // Panggil librarynya di sini
        qrcode.generate(qr, { small: true });   // <--- TAMBAHKAN BARIS INI untuk mencetak QR
    }
});
    // Listener untuk menyimpan kredensial setiap kali ada pembaruan
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

module.exports = { startWhatsAppClient };
