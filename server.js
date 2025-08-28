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
const ffmpeg = require('fluent-ffmpeg');
const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');
// --- LÍNEA NUEVA ---
const { path: ffprobePath } = require('@ffprobe-installer/ffprobe');
const PQueue = require('p-queue').default;

// --- CONFIGURACIÓN DE FFPROBE ---
ffmpeg.setFfmpegPath(ffmpegPath);
// --- LÍNEA NUEVA ---
ffmpeg.setFfprobePath(ffprobePath);


// --- CONFIGURACIÓN DE LA FILA VIRTUAL ---
const editQueue = new PQueue({ concurrency: 1 });

// --- CONFIGURACIÓN DE USUARIOS ---
const users = {
    'Dani': { passwordHash: '$2b$10$QHqRZ.aDLHQ7DR27YvkpjOaOC1Nx/LBOHd5CPOPtWzKuiLwOVEGwK' },
    'Ota': { passwordHash: '$2b$10$r5OSbNYJ931NokvlL6knR..ffWTK8HghTbTa9puw2ztrapmUlAWny' },
    'Nando': { passwordHash: '$2b$10$/j7cpg99oim5vOL6RYlT6O/qHwWaDX75kJYTNf8nAbM1VwVV5/PEK' }
};

// --- CONFIGURACIÓN INICIAL DE EXPRESS ---
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
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
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
        enum: ['pending', 'editing', 'edited', 'processing_upload', 'uploaded', 'failed'],
        default: 'pending'
    },
    youtubeUrl: String,
    uploadedBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Video = mongoose.model('Video', videoSchema);

// --- CONFIGURACIÓN DE GOOGLE Y MULTER ---
const upload = multer({ dest: 'uploads/' });
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
        requestBody: { name: fileName, parents: [] },
        media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) },
    });
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

// --- FUNCIÓN DE EDICIÓN DE VIDEO (FFMPEG) --- (VERSIÓN CON AJUSTES FINALES)
async function editVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) return reject(err);

            const originalDuration = metadata.format.duration;
            // CAMBIO: Ahora cortamos 4.5 segundos del final
            const targetDuration = originalDuration - 4.5;

            if (targetDuration <= 0) return reject(new Error("Video demasiado corto para cortar."));

            const watermarkPath = path.join(__dirname, 'watermark.png');
            if (!fs.existsSync(watermarkPath)) {
                return reject(new Error("No se encontró el archivo watermark.png en la carpeta principal."));
            }
             const fontPath = path.join(__dirname, 'Poppins-Bold.ttf');
            if (!fs.existsSync(fontPath)) {
                return reject(new Error("No se encontró el archivo de fuente Poppins-Bold.ttf en la carpeta principal."));
            }

            console.log(`🎬 Editando video... Duración original: ${originalDuration.toFixed(2)}s, nueva: ${targetDuration.toFixed(2)}s`);

            ffmpeg(inputPath)
                .input(watermarkPath)
                .complexFilter([
                    // 1. Primer overlay (izquierda, centrado vertical) - Sin cambios
                    "[0:v][1:v]overlay=x=10:y=(H-h)/2[bg1]",

                    // 2. Segundo overlay (derecha)
                    // CAMBIO: y=(H-h)/2+250 - Baja la marca de agua derecha. (Antes era -150)
                    "[bg1][1:v]overlay=x=W-w-5:y=(H-h)/2+310[bg2]",

                    // 3. drawtext (texto @NoaClips)
                    // CAMBIO: fontsize=32 (un poco más grande), y=h-th-70 (un poco más arriba)
                    `[bg2]drawtext=fontfile=./Poppins-Bold.ttf:text='@NaoClips':fontsize=32:fontcolor=white@0.9:x=(w-text_w)/2:y=h-th-120:shadowcolor=black@0.6:shadowx=2:shadowy=2`
                ])
                .duration(targetDuration)
                .output(outputPath)
                .on('end', () => {
                    console.log('✅ Edición de video completada.');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('❌ Error al editar el video:', err.message);
                    reject(new Error(`ffmpeg exited with code ${err.code}: ${err.message}`));
                })
                .run();
        });
    });
}


// --- FUNCIÓN QUE MANEJA EL PROCESO COMPLETO PARA UN VIDEO ---
async function processVideo(videoId) {
    console.log(`[FILA] Tomando video ${videoId} para procesar.`);
    const video = await Video.findById(videoId);
    if (!video) {
        console.log(`[FILA] Video ${videoId} no encontrado. Saltando.`);
        return;
    }

    await Video.findByIdAndUpdate(videoId, { status: 'editing' });

    const originalPath = `uploads/${video.originalName}`;
    const editedPath = `uploads/edited-${video.originalName}`;

    try {
        await editVideo(originalPath, editedPath);
        const driveFileId = await uploadToDrive(editedPath, video.originalName);

        await Video.findByIdAndUpdate(videoId, {
            status: 'edited',
            driveFileId: driveFileId
        });
        console.log(`[FILA] Video ${videoId} editado y listo en Drive.`);
    } catch (error) {
        console.error(`❌ Fallo en el proceso de edición para ${videoId}:`, error.message);
        await Video.findByIdAndUpdate(videoId, { status: 'failed' });
    } finally {
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(editedPath)) fs.unlinkSync(editedPath);
    }
}


// --- RUTA DE SUBIDA MODIFICADA ---
app.post('/upload', checkAuth, upload.single('videoClip'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No se subió ningún archivo.' });

    try {
        const tempPath = req.file.path;
        const safeOriginalName = req.file.originalname.replace(/\s/g, '_');
        const newTempPath = `uploads/${safeOriginalName}`;
        fs.renameSync(tempPath, newTempPath);

        const autoTitle = "TikTok:NaoClips                                              Youtube:NaoClips";
        // --- MODIFICACIÓN DE LA DESCRIPCIÓN ---
        const defaultDescription = "TikTok: NaoClips\nYouTube: NaoClips";

        const newVideo = new Video({
            originalName: safeOriginalName,
            title: autoTitle, // Título automático basado en el nombre del archivo
            description: defaultDescription,
            status: 'pending',
            uploadedBy: req.session.user.username
        });
        await newVideo.save();

        editQueue.add(() => processVideo(newVideo._id));
        console.log(`[FILA] Video ${newVideo._id} añadido a la fila de edición.`);

        res.status(201).json({ message: `Video añadido a la cola. Hay ${editQueue.size} videos esperando para ser editados.` });
    } catch (error) {
        console.error("Error en /upload:", error);
        res.status(500).json({ message: 'Error al añadir el video a la cola.' });
    }
});

// --- CRON JOB MODIFICADO ---
cron.schedule(process.env.CRON_SCHEDULE, async () => {
    console.log(`\n⏰ Cron job de YouTube ejecutándose...`);
    const isUploading = await Video.findOne({ status: 'processing_upload' });
    if (isUploading) {
        console.log('--- Ya hay un video subiéndose a YouTube.');
        return;
    }
    const nextVideoToUpload = await Video.findOne({ status: 'edited' }).sort({ createdAt: 1 });
    if (nextVideoToUpload) {
        await uploadToYouTube(nextVideoToUpload);
    } else {
        console.log('--- No hay videos listos para subir a YouTube.');
    }
});


// --- LÓGICA DE SUBIDA A YOUTUBE ---
async function uploadToYouTube(video) {
    console.log(`🚀 Empezando la subida a YouTube de: "${video.title}"`);
    await Video.findByIdAndUpdate(video._id, { status: 'processing_upload' });

    try {
        const driveStream = await drive.files.get(
            { fileId: video.driveFileId, alt: 'media' },
            { responseType: 'stream' }
        );
        const response = await youtube.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: { title: video.title, description: video.description },
                status: { privacyStatus: 'public' },
            },
            media: { body: driveStream.data },
        });
        const youtubeUrl = `https://www.youtube.com/watch?v=${response.data.id}`;
        await Video.findByIdAndUpdate(video._id, { status: 'uploaded', youtubeUrl: youtubeUrl });
        console.log(`✅ Video "${video.title}" subido con éxito: ${youtubeUrl}`);
        await deleteFromDrive(video.driveFileId);
    } catch (error) {
        console.error(`❌ Error subiendo "${video.title}" a YouTube:`, error.message);
        await Video.findByIdAndUpdate(video._id, { status: 'failed' });
    }
}


// --- RUTAS DE PÁGINAS Y API ---
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/stats.html', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));
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
    req.session.destroy(() => res.redirect('/login.html'));
});
app.get('/api/session', checkAuth, (req, res) => res.json({ user: req.session.user }));
app.get('/api/queue', checkAuth, async (req, res) => {
    const videos = await Video.find().sort({ createdAt: 1 });
    res.json(videos);
});
app.get('/api/schedule-info', checkAuth, (req, res) => res.json({ schedule: process.env.CRON_SCHEDULE }));
app.get('/api/stats', checkAuth, async (req, res) => {
    const totalUploaded = await Video.countDocuments({ status: 'uploaded' });
    const totalProcessing = await Video.countDocuments({ status: 'editing' }) + await Video.countDocuments({ status: 'processing_upload' });
    const totalPending = await Video.countDocuments({ status: 'pending' });
    const uploadsByUser = await Video.aggregate([
        { $match: { status: 'uploaded' } },
        { $group: { _id: '$uploadedBy', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
    ]);
    res.json({ totalUploaded, totalProcessing, totalPending, uploadsByUser });
});


// Iniciar el servidor
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en el puerto ${PORT}`));