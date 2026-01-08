/**
 * Script para configurar Firebase Admin SDK
 *
 * Este script te ayuda a agregar las credenciales de Firebase Admin
 * a tu archivo .env.local de forma automática
 *
 * Uso:
 * 1. Descarga el archivo JSON de credenciales desde Firebase Console
 * 2. node scripts/setup-firebase-admin.js /ruta/al/archivo-credenciales.json
 */

const fs = require('fs');
const path = require('path');

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('❌ Error: Debes proporcionar la ruta al archivo de credenciales JSON\n');
    console.log('📖 Uso:');
    console.log('   node scripts/setup-firebase-admin.js /ruta/al/archivo-credenciales.json\n');
    console.log('📝 Ejemplo:');
    console.log('   node scripts/setup-firebase-admin.js ~/Downloads/udelx-firebase-adminsdk.json\n');
    process.exit(1);
  }

  const credentialsPath = args[0];
  const envPath = path.join(process.cwd(), '.env.local');

  // Verificar que el archivo de credenciales existe
  if (!fs.existsSync(credentialsPath)) {
    console.log(`❌ Error: No se encontró el archivo: ${credentialsPath}\n`);
    process.exit(1);
  }

  // Leer el archivo JSON
  console.log('📖 Leyendo credenciales...');
  let credentials;
  try {
    const fileContent = fs.readFileSync(credentialsPath, 'utf8');
    credentials = JSON.parse(fileContent);
  } catch (error) {
    console.log('❌ Error al leer el archivo JSON:', error.message);
    process.exit(1);
  }

  // Validar que tenga los campos necesarios
  if (!credentials.project_id || !credentials.private_key || !credentials.client_email) {
    console.log('❌ Error: El archivo JSON no tiene el formato correcto de credenciales de Firebase Admin');
    process.exit(1);
  }

  console.log('✅ Credenciales válidas encontradas');
  console.log(`   Project ID: ${credentials.project_id}`);
  console.log(`   Client Email: ${credentials.client_email}\n`);

  // Leer .env.local actual (si existe)
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    console.log('📄 Archivo .env.local existente encontrado');
  } else {
    console.log('📄 Creando nuevo archivo .env.local');
  }

  // Preparar las nuevas variables
  const newVars = `
# Firebase Admin SDK Credentials
FIREBASE_ADMIN_PROJECT_ID=${credentials.project_id}
FIREBASE_ADMIN_CLIENT_EMAIL=${credentials.client_email}
FIREBASE_ADMIN_PRIVATE_KEY="${credentials.private_key.replace(/\n/g, '\\n')}"
`;

  // Eliminar variables antiguas de Firebase Admin si existen
  const lines = envContent.split('\n');
  const cleanedLines = lines.filter(line => {
    return !line.startsWith('FIREBASE_ADMIN_PROJECT_ID') &&
           !line.startsWith('FIREBASE_ADMIN_CLIENT_EMAIL') &&
           !line.startsWith('FIREBASE_ADMIN_PRIVATE_KEY') &&
           !line.startsWith('FIREBASE_SERVICE_ACCOUNT_KEY') &&
           line !== '# Firebase Admin SDK Credentials';
  });

  // Agregar las nuevas variables
  const finalContent = cleanedLines.join('\n').trim() + '\n' + newVars;

  // Crear backup del .env.local actual
  if (fs.existsSync(envPath)) {
    const backupPath = `${envPath}.backup.${Date.now()}`;
    fs.copyFileSync(envPath, backupPath);
    console.log(`💾 Backup creado: ${backupPath}`);
  }

  // Escribir el nuevo .env.local
  fs.writeFileSync(envPath, finalContent);
  console.log('✅ Variables de Firebase Admin agregadas a .env.local\n');

  console.log('━'.repeat(60));
  console.log('✅ CONFIGURACIÓN COMPLETADA\n');
  console.log('📝 Próximos pasos:');
  console.log('   1. Reinicia tu servidor de desarrollo (Ctrl+C y npm run dev)');
  console.log('   2. Ve a la página de Alumnos');
  console.log('   3. Intenta actualizar contraseñas nuevamente\n');
  console.log('⚠️  IMPORTANTE:');
  console.log('   - NO subas el archivo .env.local a GitHub');
  console.log('   - NO compartas las credenciales con nadie');
  console.log('   - Elimina el archivo JSON de credenciales de tu carpeta Downloads\n');
  console.log('━'.repeat(60));
}

main();
