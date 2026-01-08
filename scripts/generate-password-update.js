/**
 * Script para generar un archivo Excel con emails y contraseñas
 * para actualización masiva de contraseñas de alumnos
 *
 * Uso:
 * node scripts/generate-password-update.js
 */

const XLSX = require('xlsx');
const crypto = require('crypto');

// CONFIGURACIÓN
const OUTPUT_FILE = 'actualizar-contraseñas.xlsx';

// Opción 1: Generar contraseña aleatoria segura
function generateSecurePassword(length = 12) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  const randomBytes = crypto.randomBytes(length);

  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }

  return password;
}

// Opción 2: Usar una contraseña específica para todos
const CONTRASEÑA_SECRETA = 'MiContraseñaSegura2024!'; // Cámbiala aquí

// AQUÍ PONES LOS EMAILS DE TUS ALUMNOS
const alumnos = [
  'alumno1@ejemplo.com',
  'alumno2@ejemplo.com',
  'alumno3@ejemplo.com',
  // Agrega más emails aquí...
];

function main() {
  console.log('🔐 Generando archivo de actualización de contraseñas...\n');

  // Opción A: Usar la misma contraseña para todos (recomendado para empezar)
  const datos = alumnos.map(email => ({
    Email: email,
    Password: CONTRASEÑA_SECRETA
  }));

  // Opción B: Generar contraseña única para cada alumno (descomenta para usar)
  // const datos = alumnos.map(email => ({
  //   Email: email,
  //   Password: generateSecurePassword(12)
  // }));

  // Crear el archivo Excel
  const worksheet = XLSX.utils.json_to_sheet(datos);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Contraseñas');

  // Guardar el archivo
  XLSX.writeFile(workbook, OUTPUT_FILE);

  console.log(`✅ Archivo generado: ${OUTPUT_FILE}`);
  console.log(`📊 Total de alumnos: ${datos.length}\n`);

  console.log('Vista previa:');
  console.log('─'.repeat(60));
  datos.slice(0, 5).forEach((alumno, i) => {
    console.log(`${i + 1}. ${alumno.Email} → ${alumno.Password}`);
  });

  if (datos.length > 5) {
    console.log(`... y ${datos.length - 5} más`);
  }

  console.log('─'.repeat(60));
  console.log('\n📝 Próximos pasos:');
  console.log('1. Abre el archivo generado y verifica los datos');
  console.log('2. Ve a la página de Alumnos en tu aplicación');
  console.log('3. Busca la sección "Actualizar contraseñas de alumnos existentes"');
  console.log('4. Carga el archivo y haz clic en "Actualizar contraseñas"');
  console.log('\n⚠️  IMPORTANTE: Guarda este archivo en un lugar seguro');
  console.log('   Necesitarás comunicar las contraseñas a tus alumnos\n');
}

main();
