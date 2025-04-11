const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Parse the connection string
const connectionString = process.env.DATABASE_URL;

// Database connection with explicit settings
const pool = new Pool({
  connectionString,
  ssl: true  // Set to true for Neon.tech
});

// Test database connection
pool.connect()
  .then(() => console.log('Connected to NeonTech PostgreSQL database'))
  .catch(err => {
    console.error('Database connection error:', err.message);
    console.error('Please check your DATABASE_URL and ensure it has the correct format');
  });

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database - create memories table if it doesn't exist
const initializeDatabase = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id UUID PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        date TIMESTAMP WITH TIME ZONE NOT NULL,
        mood VARCHAR(50),
        tags TEXT[]
      )
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
};

// Helper for UUID validation
const ensureValidUUID = (id) => {
  if (!id || !uuidValidate(id)) {
    return uuidv4(); // Generate a new valid UUID if invalid
  }
  return id;
};

// Routes
// Get all memories
app.get('/api/memories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM memories ORDER BY date DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching memories:', error);
    res.status(500).json({ error: 'An error occurred while fetching memories' });
  }
});

// Get a single memory by id
app.get('/api/memories/:id', async (req, res) => {
  const id = ensureValidUUID(req.params.id);
  
  try {
    const result = await pool.query('SELECT * FROM memories WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching memory:', error);
    res.status(500).json({ error: 'An error occurred while fetching the memory' });
  }
});

// Create a new memory
app.post('/api/memories', async (req, res) => {
  let { id, title, content, date, mood, tags } = req.body;
  
  // Ensure the ID is a valid UUID
  id = ensureValidUUID(id);
  
  try {
    const result = await pool.query(
      'INSERT INTO memories (id, title, content, date, mood, tags) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [id, title, content, date, mood, tags]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating memory:', error);
    res.status(500).json({ error: 'An error occurred while creating the memory' });
  }
});

// Update a memory
app.put('/api/memories/:id', async (req, res) => {
  const id = ensureValidUUID(req.params.id);
  const { title, content, date, mood, tags } = req.body;
  
  try {
    const result = await pool.query(
      'UPDATE memories SET title = $1, content = $2, date = $3, mood = $4, tags = $5 WHERE id = $6 RETURNING *',
      [title, content, date, mood, tags, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating memory:', error);
    res.status(500).json({ error: 'An error occurred while updating the memory' });
  }
});

// Delete a memory
app.delete('/api/memories/:id', async (req, res) => {
  const id = ensureValidUUID(req.params.id);
  
  try {
    const result = await pool.query('DELETE FROM memories WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    
    res.json({ message: 'Memory deleted successfully' });
  } catch (error) {
    console.error('Error deleting memory:', error);
    res.status(500).json({ error: 'An error occurred while deleting the memory' });
  }
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}); 