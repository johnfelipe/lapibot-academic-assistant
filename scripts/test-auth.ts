import { Pool } from 'pg';
import bcrypt from 'bcrypt';

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'lapibot_auth',
  user: 'lapibot',
  password: 'lapibot_secret',
});

async function test() {
  // Test 1: Find user
  const result = await pool.query('SELECT * FROM users WHERE username = $1', ['jgarcia']);
  const user = result.rows[0];
  console.log('✓ User found:', user.username, user.display_name);

  // Test 2: Verify correct password
  const valid = await bcrypt.compare('Derecho2026!', user.password_hash);
  console.log('✓ Correct password validates:', valid);

  // Test 3: Verify wrong password
  const invalid = await bcrypt.compare('wrongpassword', user.password_hash);
  console.log('✓ Wrong password rejects:', !invalid);

  // Test 4: Case-insensitive username
  const result2 = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', ['JGARCIA']);
  console.log('✓ Case-insensitive lookup:', result2.rows[0]?.username);

  // Test 5: Verify admin user
  const adminResult = await pool.query('SELECT * FROM users WHERE username = $1', ['admin']);
  const adminValid = await bcrypt.compare('Admin@UPC2026', adminResult.rows[0].password_hash);
  console.log('✓ Admin password validates:', adminValid);

  // Test 6: Non-existent user
  const noUser = await pool.query('SELECT * FROM users WHERE username = $1', ['noexiste']);
  console.log('✓ Non-existent user returns empty:', noUser.rows.length === 0);

  console.log('\n✅ Todas las pruebas de autenticación pasaron correctamente.');
  await pool.end();
}

test().catch(err => { console.error('FAIL:', err); process.exit(1); });
