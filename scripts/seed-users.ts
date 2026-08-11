/**
 * Seed script: Creates 10 users in PostgreSQL with bcrypt-hashed passwords.
 * 
 * Run: npx ts-node scripts/seed-users.ts
 */

import { Pool } from 'pg';
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'lapibot_auth',
  user: process.env.PGUSER || 'lapibot',
  password: process.env.PGPASSWORD || 'lapibot_secret',
});

interface UserSeed {
  username: string;
  password: string; // plain text (will be hashed)
  display_name: string;
  role: string;
}

const users: UserSeed[] = [
  { username: 'jgarcia', password: 'Derecho2026!', display_name: 'Juan García López', role: 'student' },
  { username: 'mrodriguez', password: 'IALegal#01', display_name: 'María Rodríguez Pérez', role: 'student' },
  { username: 'clopez', password: 'UPC_Curso99', display_name: 'Carlos López Mendoza', role: 'student' },
  { username: 'amorales', password: 'Abogada2026', display_name: 'Ana Morales Quispe', role: 'student' },
  { username: 'rcastillo', password: 'Tech&Law42', display_name: 'Roberto Castillo Vargas', role: 'student' },
  { username: 'lherrera', password: 'Prompt!ng3', display_name: 'Lucía Herrera Díaz', role: 'student' },
  { username: 'dnavarro', password: 'MCP_Skills1', display_name: 'Diego Navarro Ruiz', role: 'student' },
  { username: 'pfernandez', password: 'Agent2026$', display_name: 'Patricia Fernández Soto', role: 'student' },
  { username: 'evargas', password: 'Workflow!7', display_name: 'Eduardo Vargas Huamán', role: 'student' },
  { username: 'admin', password: 'Admin@UPC2026', display_name: 'Administrador del Curso', role: 'admin' },
];

async function seed() {
  console.log('Creating users table...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      role VARCHAR(20) DEFAULT 'student',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
    );
  `);

  console.log('Inserting 10 users with bcrypt-hashed passwords...\n');

  for (const user of users) {
    const hash = await bcrypt.hash(user.password, SALT_ROUNDS);
    
    await pool.query(
      `INSERT INTO users (username, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         display_name = EXCLUDED.display_name,
         role = EXCLUDED.role`,
      [user.username, hash, user.display_name, user.role]
    );

    console.log(`  ✓ ${user.username} (${user.display_name}) [${user.role}]`);
  }

  console.log('\n─── Usuarios creados ───────────────────────────────────────');
  console.log('');
  console.log('  Usuario       | Contraseña    | Nombre');
  console.log('  ─────────────────────────────────────────────────────────');
  for (const user of users) {
    console.log(`  ${user.username.padEnd(14)} | ${user.password.padEnd(13)} | ${user.display_name}`);
  }
  console.log('');
  console.log('Nota: Las contraseñas están hasheadas con bcrypt (12 rounds)');
  console.log('      en la base de datos. Los valores de arriba son solo');
  console.log('      para referencia/testing.');

  // Verify
  const result = await pool.query('SELECT id, username, display_name, role, is_active FROM users ORDER BY id');
  console.log(`\n✓ ${result.rowCount} usuarios en la base de datos.`);

  await pool.end();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
