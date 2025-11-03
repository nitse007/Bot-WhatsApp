// --- 1. Importar las librerías ---
const { 
    default: makeWASocket, 
    useMultiFileAuthState, // <-- ¡Importante! Lo usaremos de una forma especial
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    Browsers
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Sticker } = require('wa-sticker-formatter');
const { MongoClient } = require('mongodb'); // <-- ¡Importamos MongoDB!

// --- ¡NUEVO! Configuración de MongoDB ---
// ¡¡¡PEGA AQUÍ TU URI DE CONEXIÓN DE ATLAS!!!
const MONGO_URI = "mongodb+srv://nitse:3OPTKa2RfoTjogTn@nitse.lkimjbq.mongodb.net/?appName=nitse";
const MONGO_DB_NAME = "bot_whatsapp"; // Nombre de tu base de datos
const MONGO_COLLECTION_NAME = "auth_session"; // Nombre de la colección

// --- ¡NUEVO! Función para crear el almacén de autenticación en MongoDB ---
async function createMongoAuthStore() {
    console.log('Conectando a MongoDB...');
    const client = new MongoClient(MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });
    await client.connect();
    console.log('Conexión a MongoDB exitosa.');

    const collection = client.db(MONGO_DB_NAME).collection(MONGO_COLLECTION_NAME);

    // Función para normalizar claves (Baileys usa ":" que no es válido en Mongo)
    const fixKey = (key) => key.replace(/:/g, '__');
    const unfixKey = (key) => key.replace(/__/g, ':');

    // Funciones que Baileys necesita para leer y escribir
    const store = {
        async readData(key) {
            try {
                const doc = await collection.findOne({ _id: fixKey(key) });
                if (doc) {
                    return doc.value;
                }
                return null;
            } catch (e) {
                console.error("Error al leer de MongoDB", e);
                return null;
            }
        },
        async writeData(key, value) {
            try {
                await collection.updateOne(
                    { _id: fixKey(key) },
                    { $set: { value } },
                    { upsert: true }
                );
            } catch (e) {
                console.error("Error al escribir en MongoDB", e);
            }
        },
        async removeData(key) {
            try {
                await collection.deleteOne({ _id: fixKey(key) });
            } catch (e) {
                console.error("Error al borrar de MongoDB", e);
            }
        },
        // Esta es necesaria para que useMultiFileAuthState funcione
        async listData() {
            const cursor = collection.find({});
            const keys = [];
            for await (const doc of cursor) {
                keys.push(unfixKey(doc._id));
            }
            return keys;
        }
    };
    
    // Adaptamos las funciones para que Baileys las entienda
    const authStore = {
        state: {
            creds: null,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        const value = await store.readData(key);
                        if (value) {
                            data[id] = value;
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const [type, update] of Object.entries(data)) {
                        for (const [id, value] of Object.entries(update)) {
                            const key = `${type}-${id}`;
                            await store.writeData(key, value);
                        }
                    }
                },
            },
        },
        saveCreds: async (creds) => {
            await store.writeData('creds', creds);
            authStore.state.creds = creds;
        },
    };
    
    // Cargar credenciales existentes al inicio
    authStore.state.creds = await store.readData('creds');
    
    return authStore;
}

// --- 2. La Función Principal del Bot (AHORA ES ASÍNCRONA) ---
async function connectToWhatsApp() {
    
    // ¡NUEVO! Usamos nuestra función de MongoDB
    const { state, saveCreds } = await createMongoAuthStore();
    
    const { version } = await fetchLatestBaileysVersion();

    // Inicia la conexión
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: state.keys,
        },
        logger: pino({ level: 'info' }), // Subimos el nivel a 'info' para ver más detalles
        printQRInTerminal: true, // ¡Importante para PaaS! El QR se verá en los logs
        browser: Browsers.macOS('Desktop'), // Simula ser un navegador para más estabilidad
    });

    // Guarda las credenciales cada vez que cambien
    sock.ev.on('creds.update', saveCreds);

    // --- 3. Manejador de Conexión ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // ¡Importante! En Render, no verás un QR, sino un texto.
            console.log('¡QR recibido! Escanéalo con tu teléfono. Si estás en Render, copia este texto en los logs:');
            qrcode.generate(qr, { small: true }); // Esto también imprime en los logs
        }

        if (connection === 'open') {
            console.log('¡Bot conectado y en línea!');
        } 
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp(); 
            } else {
                console.error('¡Desconexión fatal! La sesión se cerró (probablemente escaneaste en otro lugar).');
                // En un PaaS, esto debería hacer que el proceso se detenga para que el PaaS lo reinicie
                process.exit(1); 
            }
        }
    });

    // --- 4. Manejador de Mensajes (Solo Stickers) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!messageText) return;

        const command = messageText.toLowerCase().trim();
        const from = msg.key.remoteJid;
        const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        if (command === '!sticker') {
            console.log(`Comando !sticker recibido de ${from}`);
            if (!quotedMsg) {
                await sock.sendMessage(from, { text: 'Debes *responder* a una imagen con el comando `!sticker`' });
                return;
            }
            if (quotedMsg.imageMessage) {
                console.log('Procesando imagen con wa-sticker-formatter...');
                try {
                    // (Aquí fallará en Render porque no hay ffmpeg, pero el bot seguirá vivo)
                    const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    const sticker = new Sticker(buffer, { pack: 'Bot - ia - nitse', author: 'Creado por Bot', type: 'default', quality: 75 });
                    const stickerBuffer = await sticker.toBuffer();
                    await sock.sendMessage(from, { sticker: stickerBuffer });
                    console.log('¡Sticker enviado!');
                } catch (e) {
                    console.error('Error al crear el sticker (probablemente falta ffmpeg):', e.message);
                    await sock.sendMessage(from, { text: '¡Ups! Esta función (sticker) está deshabilitada en el servidor.' });
                }
            } else {
                await sock.sendMessage(from, { text: 'Solo puedo convertir *imágenes* en stickers.' });
            }
        }
    });
}

// --- 5. Iniciar el Bot ---
connectToWhatsApp();