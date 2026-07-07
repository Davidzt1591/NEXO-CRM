/**
 * NEXO — CLI Dashboard Token Generator
 * 
 * Usage:
 *   node scripts/generate-key.js --name "Analista" --role admin
 */

const { initDb, createToken } = require('../src/database/db');

// Basic CLI parser
const args = process.argv.slice(2);
let name = null;
let role = 'agent'; // default role

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--name' || args[i] === '-n') {
    name = args[i + 1];
  }
  if (args[i] === '--role' || args[i] === '-r') {
    role = args[i + 1];
  }
}

if (!name) {
  console.error('\n❌ Error: El nombre es obligatorio.');
  console.log('Uso correcto:');
  console.log('  node scripts/generate-key.js --name "Nombre Completo" [--role admin|agent]\n');
  process.exit(1);
}

const validRoles = ['admin', 'agent'];
if (!validRoles.includes(role)) {
  console.error(`\n❌ Error: Rol inválido "${role}". Roles permitidos: ${validRoles.join(', ')}\n`);
  process.exit(1);
}

(async () => {
  try {
    // 1. Initialize SQLite Database
    await initDb();

    // 2. Generate and save token
    const result = createToken({ name, role });

    console.log('\n🔑 ──────────────────────────────────────────────────────────────');
    console.log('   NEXO DASHBOARD TOKEN GENERADO EXITOSAMENTE');
    console.log('──────────────────────────────────────────────────────────────────');
    console.log(`   Propietario : ${result.name}`);
    console.log(`   Rol         : ${result.role}`);
    console.log(`   Token       : ${result.rawToken}`);
    console.log('──────────────────────────────────────────────────────────────────');
    console.log('   ⚠️  IMPORTANTE: Copia este token ahora. No se volverá a mostrar.');
    console.log('   El dashboard requerirá este token para poder conectarse.\n');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error al generar el token:', err.message);
    process.exit(1);
  }
})();
