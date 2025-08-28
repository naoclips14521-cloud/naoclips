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

// --- CONFIGURACIÓN INICIAL ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// --- BASE DE DATOS (MONGODB) ---
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ Conectado a MongoDB'))
    .catch(err => console.error('❌ Error al conectar a MongoDB:', err));

const videoSchema = new mongoose.Schema({
    originalName: String,
    driveFileId: String,
    title: String,
    description: String, // Añadimos el campo de descripción al Schema
    status: {
        type: String,
        enum: ['pending', 'processing', 'uploaded', 'failed'],
        default: 'pending'
    },
    youtubeUrl: String,
    createdAt: { type: Date, default: Date.now }
});
const Video = mongoose.model('Video', videoSchema);

// --- ALMACENamiento TEMPORAL (MULTER) ---
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

// --- RUTAS DE LA API ---
app.post('/upload', upload.single('videoClip'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No se subió ningún archivo.' });

    try {
        const driveFileId = await uploadToDrive(req.file.path, req.file.originalname);
        const autoTitle = path.parse(req.file.originalname).name;

        // --- CAMBIO AQUÍ: Texto predeterminado ---
        const defaultDescription = "Sígueme en mis redes!\n\nTikTok: NoaClips\nYouTube: NoaClips";

        const newVideo = new Video({
            originalName: req.file.originalname,
            driveFileId: driveFileId,
            title: autoTitle,
            description: defaultDescription, // Se asigna la descripción por defecto
            status: 'pending'
        });

        await newVideo.save();
        res.status(201).json({ message: 'Video subido a Drive y añadido a la cola.' });
    } catch (error) {
        console.error("Error en el proceso de subida:", error);
        res.status(500).json({ message: 'Error al subir el archivo a Google Drive.' });
    }
});

app.get('/queue', async (req, res) => {
    try {
        const videos = await Video.find().sort({ createdAt: 1 });
        res.json(videos);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener la cola.' });
    }
});

app.get('/schedule-info', (req, res) => {
    res.json({ schedule: process.env.CRON_SCHEDULE });
});


// --- LÓGICA DE SUBIDA A YOUTUBE ---
async function uploadToYouTube(video) {
    console.log(`🚀 Empezando la subida a YouTube de: "${video.title}"`);
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
                    description: video.description, // Usamos la descripción guardada
                },
                status: { privacyStatus: 'public' },
            },
            media: {
                body: driveStream.data,
            },
        });

        const videoId = response.data.id;
        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        await Video.findByIdAndUpdate(video._id, { status: 'uploaded', youtubeUrl });
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
    console.log(`🕒 El trabajo está programado para ejecutarse según: ${process.env.CRON_SCHEDULE}`);
});