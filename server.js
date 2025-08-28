// Cargar variables de entorno
require('dotenv').config();

// Dependencias
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { google } = require('googleapis');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');

// --- CONFIGURACIÓN DE USUARIOS ---
// ¡IMPORTANTE! Las contraseñas aquí deben estar "hasheadas".
// Usa el script 'hash-password.js' para generar estos hashes.
// Ejemplo: 'Dani': { passwordHash: '$2b$10$TU_HASH_AQUI_PARA_DANI' }
const users = {
    'Dani': { passwordHash: '$2b$10$QHqRZ.aDLHQ7DR27YvkpjOaOC1Nx/LBOHd5CPOPtWzKuiLwOVEGwK' },
    'Ota': { passwordHash: '$2b$10$r5OSbNYJ931NokvlL6knR..ffWTK8HghTbTa9puw2ztrapmUlAWny' },
    'Nando': { passwordHash: '$2b$10$/j7cpg99oim5vOL6RYlT6O/qHwWaDX75kJYTNf8nAbM1VwVV5/PEK' }
};

// --- CONFIGURACIÓN INICIAL ---
const app = express();
app.set('trust proxy', 1); 
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de Sesiones
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', // En Render será 'true', en local 'false'
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 1 día de sesión
    }
}));

// Middleware para proteger rutas
const checkAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login.html');
    }
};

// --- BASE DE DATOS (MONGODB) ---
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ Conectado a MongoDB'))
    .catch(err => console.error('❌ Error al conectar a MongoDB:', err));

const videoSchema = new mongoose.Schema({
    originalName: String,
    driveFileId: String,
    title: String,
    description: String,
    status: {
        type: String,
        enum: ['pending', 'processing', 'uploaded', 'failed'],
        default: 'pending'
    },
    youtubeUrl: String,
    uploadedBy: { type: String, required: true }, // Nuevo campo
    createdAt: { type: Date, default: Date.now }
});
const Video = mongoose.model('Video', videoSchema);

// --- ALMACENAMIENTO TEMPORAL (MULTER) ---
const upload = multer({ dest: 'uploads/' });

// --- AUTENTICACIÓN CON GOOGLE ---
const CLIENT_SECRET_PATH = path.join(__dirname, 'client_secret.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const credentials = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH));
const { client_secret, client_id, redirect_uris } = credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
oAuth2Client.setCredentials(token);

const youtube = google.youtube({ version: 'v3', auth: oAuth2Client });
const drive = google.drive({ version: 'v3', auth: oAuth2Client });

// --- FUNCIONES DE GOOGLE DRIVE ---
async function uploadToDrive(filePath, fileName) {
    console.log(`📤 Subiendo ${fileName} a Google Drive...`);
    const response = await drive.files.create({
        requestBody: {
            name: fileName,
            parents: [],
        },
        media: {
            mimeType: 'video/mp4',
            body: fs.createReadStream(filePath),
        },
    });
    fs.unlinkSync(filePath);
    console.log(`✅ Archivo guardado en Drive con ID: ${response.data.id}`);
    return response.data.id;
}

async function deleteFromDrive(fileId) {
    try {
        await drive.files.delete({ fileId: fileId });
        console.log(`🗑️ Archivo ${fileId} borrado de Google Drive.`);
    } catch (error) {
        console.error(`❌ Error al borrar ${fileId} de Drive:`, error.message);
    }
}

// --- RUTAS DE LA APLICACIÓN ---

// Rutas de las páginas (protegidas por checkAuth)
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/stats.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));

// Rutas de Autenticación
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users[username];
    if (user && await bcrypt.compare(password, user.passwordHash)) {
        req.session.user = { username };
        res.redirect('/');
    } else {
        res.send('Usuario o contraseña incorrectos. <a href="/login.html">Intentar de nuevo</a>');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/login.html');
    });
});

// Rutas de la API (protegidas por checkAuth)
app.post('/upload', checkAuth, upload.single('videoClip'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No se subió ningún archivo.' });
    try {
        const driveFileId = await uploadToDrive(req.file.path, req.file.originalname);
        const autoTitle = path.parse(req.file.originalname).name;
        const defaultDescription = "Sígueme en mis redes!\n\nTikTok: NoaClips\nYouTube: NoaClips";
        
        const newVideo = new Video({
            originalName: req.file.originalname,
            driveFileId: driveFileId,
            title: autoTitle,
            description: defaultDescription,
            status: 'pending',
            uploadedBy: req.session.user.username // Guardamos el usuario que subió el video
        });
        
        await newVideo.save();
        res.status(201).json({ message: 'Video añadido a la cola.' });
    } catch (error) {
        console.error("Error en el proceso de subida:", error);
        res.status(500).json({ message: 'Error al subir el archivo a Google Drive.' });
    }
});

app.get('/api/session', checkAuth, (req, res) => {
    res.json({ user: req.session.user });
});

app.get('/api/queue', checkAuth, async (req, res) => {
    const videos = await Video.find().sort({ createdAt: 1 });
    res.json(videos);
});

app.get('/api/schedule-info', checkAuth, (req, res) => {
    res.json({ schedule: process.env.CRON_SCHEDULE });
});

app.get('/api/stats', checkAuth, async (req, res) => {
    try {
        const totalUploaded = await Video.countDocuments({ status: 'uploaded' });
        const totalProcessing = await Video.countDocuments({ status: 'processing' });
        const totalPending = await Video.countDocuments({ status: 'pending' });

        const uploadsByUser = await Video.aggregate([
            { $match: { status: 'uploaded' } },
            { $group: { _id: '$uploadedBy', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        res.json({
            totalUploaded,
            totalProcessing,
            totalPending,
            uploadsByUser
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener estadísticas.' });
    }
});

// --- LÓGICA DE SUBIDA A YOUTUBE ---
async function uploadToYouTube(video) {
    console.log(`🚀 Empezando la subida a YouTube de: "${video.title}" por ${video.uploadedBy}`);
    await Video.findByIdAndUpdate(video._id, { status: 'processing' });

    try {
        const driveStream = await drive.files.get(
            { fileId: video.driveFileId, alt: 'media' },
            { responseType: 'stream' }
        );

        const response = await youtube.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title: video.title,
                    description: video.description,
                },
                status: { privacyStatus: 'public' },
            },
            media: {
                body: driveStream.data,
            },
        });

        const videoId = response.data.id;
        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        await Video.findByIdAndUpdate(video._id, { status: 'uploaded', youtubeUrl: youtubeUrl });
        console.log(`✅ Video "${video.title}" subido con éxito: ${youtubeUrl}`);
        
        await deleteFromDrive(video.driveFileId);

    } catch (error) {
        console.error(`❌ Error subiendo "${video.title}" a YouTube:`, error.message);
        await Video.findByIdAndUpdate(video._id, { status: 'failed' });
    }
}

// --- PROGRAMADOR AUTOMÁTICO (CRON JOB) ---
cron.schedule(process.env.CRON_SCHEDULE, async () => {
    console.log(`\n⏰ Cron job ejecutándose... [${new Date().toLocaleString()}]`);
    
    const processingVideo = await Video.findOne({ status: 'processing' });
    if (processingVideo) {
        console.log('--- Ya hay un video subiéndose. Esperando al siguiente ciclo.');
        return;
    }

    const nextVideo = await Video.findOne({ status: 'pending' }).sort({ createdAt: 1 });

    if (nextVideo) {
        await uploadToYouTube(nextVideo);
    } else {
        console.log('--- No hay videos en la cola. Durmiendo...');
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});