const bcrypt = require('bcrypt');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('--- Generador de Hashes de Contraseña para NoaClips ---');
rl.question('Por favor, ingresa la contraseña que quieres encriptar: ', (password) => {
  if (!password) {
    console.error('No se ingresó ninguna contraseña. Abortando.');
    rl.close();
    return;
  }

  const saltRounds = 10;
  bcrypt.hash(password, saltRounds, function(err, hash) {
    if (err) {
      console.error('Error al generar el hash:', err);
      rl.close();
      return;
    }
    
    console.log('\n¡Éxito!');
    console.log('Copia este hash y pégalo en la lista de usuarios de tu archivo server.js:');
    console.log('-------------------------------------------------------------------');
    console.log(hash);
    console.log('-------------------------------------------------------------------');
    rl.close();
  });
});