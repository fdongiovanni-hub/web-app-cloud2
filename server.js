require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.json());
app.use(express.static('public')); // serve la pagina web dalla cartella public/

//DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      title VARCHAR(100) NOT NULL,
      pages INTEGER NOT NULL CHECK (pages > 0),
      price NUMERIC(8,2) NOT NULL CHECK (price >= 0),
      available BOOLEAN NOT NULL DEFAULT TRUE,
      published_date DATE,
      cover_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS job_logs (
      id SERIAL PRIMARY KEY,
      run_at TIMESTAMP DEFAULT NOW(),
      deleted_count INTEGER NOT NULL
    );
  `);
}

// --- UTILITY ---
// Permette di gestire gli errori delle funzioni async in un punto solo
const h = fn => (req, res, next) => fn(req, res, next).catch(next);

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id non valido' });
    return null;
  }
  return id;
}

// --- VALIDAZIONE (5 tipi di dato) ---
function validateBook(b) {
  const errors = [];
  if (typeof b.title !== 'string' || b.title.trim().length < 1 || b.title.length > 100)
    errors.push('title deve essere una stringa di 1-100 caratteri');
  if (!Number.isInteger(b.pages) || b.pages <= 0)
    errors.push('pages deve essere un intero maggiore di 0');
  if (typeof b.price !== 'number' || !Number.isFinite(b.price) || b.price < 0)
    errors.push('price deve essere un numero decimale >= 0');
  if (typeof b.available !== 'boolean')
    errors.push('available deve essere true o false');
  if (b.published_date !== undefined && b.published_date !== null && b.published_date !== '') {
    const ok = typeof b.published_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.published_date);
    const d = new Date(b.published_date);
    if (!ok || isNaN(d)) errors.push('published_date deve avere formato YYYY-MM-DD');
    else if (d > new Date()) errors.push('published_date non può essere nel futuro');
  }
  return errors;
}

// --- CRUD ---
// LIST
app.get('/api/books', h(async (req, res) => {
  const r = await pool.query('SELECT * FROM books ORDER BY id');
  res.json(r.rows);
}));

// READ
app.get('/api/books/:id', h(async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  const r = await pool.query('SELECT * FROM books WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'libro non trovato' });
  res.json(r.rows[0]);
}));

// CREATE
app.post('/api/books', h(async (req, res) => {
  const b = req.body;
  const errors = validateBook(b);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const r = await pool.query(
    `INSERT INTO books (title, pages, price, available, published_date)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.title.trim(), b.pages, b.price, b.available, b.published_date || null]
  );
  res.status(201).json(r.rows[0]);
}));

// UPDATE
app.put('/api/books/:id', h(async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  const b = req.body;
  const errors = validateBook(b);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const r = await pool.query(
    `UPDATE books SET title=$1, pages=$2, price=$3, available=$4, published_date=$5
     WHERE id=$6 RETURNING *`,
    [b.title.trim(), b.pages, b.price, b.available, b.published_date || null, id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'libro non trovato' });
  res.json(r.rows[0]);
}));

// DELETE
app.delete('/api/books/:id', h(async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  const r = await pool.query('DELETE FROM books WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'libro non trovato' });
  res.status(204).end();
}));

// --- FILE STORAGE (upload copertina) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // max 2 MB
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Sono ammesse solo immagini'))
});

app.post('/api/books/:id/cover', upload.single('cover'), h(async (req, res) => {
  const id = parseId(req, res); if (!id) return;
  if (!req.file) return res.status(400).json({ error: 'nessun file ricevuto (campo "cover")' });
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder: 'books' }, (err, r) => (err ? reject(err) : resolve(r)))
      .end(req.file.buffer);
  });
  const r = await pool.query(
    'UPDATE books SET cover_url=$1 WHERE id=$2 RETURNING *',
    [result.secure_url, id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'libro non trovato' });
  res.json(r.rows[0]);
}));

// --- BACKGROUND JOB ---
// Chiamato ogni giorno da GitHub Actions. Protetto da un token segreto.
app.post('/api/jobs/cleanup', h(async (req, res) => {
  if (req.get('x-job-token') !== process.env.JOB_TOKEN)
    return res.status(401).json({ error: 'non autorizzato' });
  const days = req.query.days === undefined ? 30 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 0)
    return res.status(400).json({ error: 'days deve essere un intero >= 0' });
  const del = await pool.query(
    `DELETE FROM books WHERE available = false
     AND created_at < NOW() - make_interval(days => $1)`, [days]);
  await pool.query('INSERT INTO job_logs (deleted_count) VALUES ($1)', [del.rowCount]);
  res.json({ deleted: del.rowCount });
}));

app.get('/api/jobs/logs', h(async (req, res) => {
  const r = await pool.query('SELECT * FROM job_logs ORDER BY id DESC LIMIT 20');
  res.json(r.rows);
}));

// --- GESTIONE ERRORI ---
app.use((err, req, res, next) => {
  console.error(err);
  const clientError = err.name === 'MulterError' || err.message === 'Sono ammesse solo immagini';
  res.status(clientError ? 400 : 500).json({ error: clientError ? err.message : 'errore interno del server' });
});

// --- AVVIO ---
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log('Server attivo sulla porta ' + PORT));
}).catch(e => { console.error('Errore DB', e); process.exit(1); });