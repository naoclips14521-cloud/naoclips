// get_token.js (ACTUALIZADO)
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLIENT_SECRET_PATH = path.join(__dirname, 'client_secret.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// ¡¡AÑADIMOS EL PERMISO DE GOOGLE DRIVE!!
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/drive.file'
];

const credentials = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH));
const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // Forzamos que pida permiso de nuevo
});

console.log('Autoriza esta app (CON EL NUEVO PERMISO DE DRIVE) visitando esta URL:', authUrl);
rl.question('Ingresa el código que obtuviste de la URL aquí: ', (code) => {
  rl.close();
  oAuth2Client.getToken(code, (err, token) => {
    if (err) return console.error('Error al obtener el token de acceso', err);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    console.log('¡Token actualizado con permisos de Drive y guardado en token.json!');
  });
});