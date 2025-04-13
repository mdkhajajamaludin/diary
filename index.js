const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Configure multer for memory storage (not disk storage)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only image files are allowed!"));
  }
});

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

// Create a virtual endpoint to serve images from the database
app.get('/api/images/:id', async (req, res) => {
  try {
    const id = req.params.id;
    
    // Check if the ID is valid
    if (!uuidValidate(id)) {
      return res.status(400).json({ error: 'Invalid image ID' });
    }
    
    // Check if the memory_images table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'memory_images'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      console.log('memory_images table does not exist yet');
      return res.status(404).json({ error: 'Image not found (table does not exist)' });
    }
    
    // Get the image from the database
    const result = await pool.query(
      'SELECT image_data, image_mime FROM memory_images WHERE memory_id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Get the image data and MIME type
    const { image_data, image_mime } = result.rows[0];
    
    // Set the content type and send the image data
    res.setHeader('Content-Type', image_mime);
    res.send(Buffer.from(image_data, 'base64'));
  } catch (error) {
    console.error('Error retrieving image:', error);
    res.status(500).json({ error: 'An error occurred while retrieving the image' });
  }
});

// Initialize database - create memories table if it doesn't exist
const initializeDatabase = async () => {
  try {
    // Create memories table if it doesn't exist
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

    // Check if the has_image column exists, add it if not
    const hasImageCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'memories' AND column_name = 'has_image'
    `);
    
    if (hasImageCheck.rows.length === 0) {
      console.log('Adding has_image column to memories table');
      await pool.query(`
        ALTER TABLE memories 
        ADD COLUMN has_image BOOLEAN DEFAULT false
      `);
    }

    // Check if the old image_path column exists and migrate data if needed
    const imagePathCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'memories' AND column_name = 'image_path'
    `);
    
    if (imagePathCheck.rows.length > 0) {
      console.log('Found old image_path column, migrating data...');
      
      // Set has_image = true for memories that had image paths
      await pool.query(`
        UPDATE memories
        SET has_image = true
        WHERE image_path IS NOT NULL
      `);
      
      // Get memories with images to migrate them to the memory_images table
      const memoryImages = await pool.query(`
        SELECT id, image_path FROM memories WHERE image_path IS NOT NULL
      `);
      
      console.log(`Found ${memoryImages.rows.length} memories with images to migrate`);
      
      // Create memory_images table if it doesn't exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS memory_images (
          id SERIAL PRIMARY KEY,
          memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
          image_data TEXT NOT NULL,
          image_mime VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
      
      // Try to drop the old column if migration was successful
      try {
        await pool.query(`
          ALTER TABLE memories
          DROP COLUMN image_path
        `);
        console.log('Dropped old image_path column');
      } catch (dropError) {
        console.error('Error dropping image_path column:', dropError);
      }
    } else {
      // Create memory_images table if it doesn't exist (no migration needed)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS memory_images (
          id SERIAL PRIMARY KEY,
          memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
          image_data TEXT NOT NULL,
          image_mime VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
    }
    
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

// Create a new memory with image upload
app.post('/api/memories', upload.single('image'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    let { id, title, content, date, mood, tags } = req.body;
    
    // Parse tags if it's a string
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch {
        tags = tags.split(',').map(tag => tag.trim());
      }
    }
    
    // Ensure the ID is a valid UUID
    id = ensureValidUUID(id);
    
    // Check if an image was uploaded
    const hasImage = !!req.file;
    
    // Check if the has_image column exists, add it if not
    const hasImageColumnCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'memories' AND column_name = 'has_image'
    `);
    
    if (hasImageColumnCheck.rows.length === 0) {
      console.log('Adding has_image column to memories table');
      await client.query(`
        ALTER TABLE memories 
        ADD COLUMN has_image BOOLEAN DEFAULT false
      `);
    }
    
    // Insert the memory
    const memoryResult = await client.query(
      'INSERT INTO memories (id, title, content, date, mood, tags, has_image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [id, title, content, date, mood, tags, hasImage]
    );
    
    let memory = memoryResult.rows[0];
    
    // If an image was uploaded, store it in the database
    if (req.file) {
      // Create the memory_images table if it doesn't exist
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_images (
          id SERIAL PRIMARY KEY,
          memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
          image_data TEXT NOT NULL,
          image_mime VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
      
      // Convert the image buffer to a base64 string
      const imageData = req.file.buffer.toString('base64');
      
      // Insert the image
      await client.query(
        'INSERT INTO memory_images (memory_id, image_data, image_mime) VALUES ($1, $2, $3)',
        [id, imageData, req.file.mimetype]
      );
    }
    
    await client.query('COMMIT');
    
    res.status(201).json(memory);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating memory:', error);
    res.status(500).json({ error: 'An error occurred while creating the memory' });
  } finally {
    client.release();
  }
});

// Update a memory with image upload
app.put('/api/memories/:id', upload.single('image'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const id = ensureValidUUID(req.params.id);
    let { title, content, date, mood, tags, deleteImage } = req.body;
    
    console.log('Update request received:', { 
      id, 
      title: title?.substring(0, 20) + '...', 
      content: content?.substring(0, 20) + '...', 
      date,
      mood,
      deleteImage,
      hasFile: !!req.file
    });
    
    // Check if memory exists first
    const memoryExists = await client.query('SELECT id FROM memories WHERE id = $1', [id]);
    if (memoryExists.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Memory not found' });
    }
    
    // Check if the has_image column exists, add it if not
    const hasImageColumnCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'memories' AND column_name = 'has_image'
    `);
    
    if (hasImageColumnCheck.rows.length === 0) {
      console.log('Adding has_image column to memories table');
      await client.query(`
        ALTER TABLE memories 
        ADD COLUMN has_image BOOLEAN DEFAULT false
      `);
    }
    
    // Parse tags if it's a string
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch (error) {
        console.log('Error parsing tags JSON, falling back to comma split:', error);
        tags = tags.split(',').map(tag => tag.trim());
      }
    }
    
    // Ensure tags is an array
    if (!Array.isArray(tags)) {
      tags = [];
    }
    
    // Set default values for any missing fields
    title = title || '';
    content = content || '';
    date = date || new Date().toISOString();
    mood = mood || 'happy';
    
    // Determine if we should update the image
    let hasImage = false;
    
    if (req.file) {
      // New image was uploaded
      hasImage = true;
      
      // Delete old image if it exists
      await client.query('DELETE FROM memory_images WHERE memory_id = $1', [id]);
      
      // Create the memory_images table if it doesn't exist
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_images (
          id SERIAL PRIMARY KEY,
          memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
          image_data TEXT NOT NULL,
          image_mime VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
      
      // Convert the image buffer to a base64 string and store it
      const imageData = req.file.buffer.toString('base64');
      
      // Insert the new image
      await client.query(
        'INSERT INTO memory_images (memory_id, image_data, image_mime) VALUES ($1, $2, $3)',
        [id, imageData, req.file.mimetype]
      );
    } else if (deleteImage === 'true') {
      // Delete image without replacement
      hasImage = false;
      await client.query('DELETE FROM memory_images WHERE memory_id = $1', [id]);
    } else {
      // Keep existing image status
      const existingMemory = await client.query('SELECT has_image FROM memories WHERE id = $1', [id]);
      hasImage = existingMemory.rows[0]?.has_image || false;
    }
    
    // Update the memory
    const result = await client.query(
      'UPDATE memories SET title = $1, content = $2, date = $3, mood = $4, tags = $5, has_image = $6 WHERE id = $7 RETURNING *',
      [title, content, date, mood, tags, hasImage, id]
    );
    
    await client.query('COMMIT');
    
    console.log('Memory updated successfully');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating memory:', error);
    res.status(500).json({ 
      error: 'An error occurred while updating the memory',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    client.release();
  }
});

// Delete a memory
app.delete('/api/memories/:id', async (req, res) => {
  const id = ensureValidUUID(req.params.id);
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Delete the memory (this will cascade to delete associated images due to foreign key constraint)
    const result = await client.query('DELETE FROM memories WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Memory not found' });
    }
    
    await client.query('COMMIT');
    res.json({ message: 'Memory deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting memory:', error);
    res.status(500).json({ 
      error: 'An error occurred while deleting the memory',
      details: error.message 
    });
  } finally {
    client.release();
  }
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}); 