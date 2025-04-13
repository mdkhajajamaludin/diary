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

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

    // Check if image_path column exists, add it if not
    const checkColumn = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'memories' AND column_name = 'image_path'
    `);
    
    if (checkColumn.rows.length === 0) {
      console.log('Adding image_path column to memories table');
      await pool.query(`
        ALTER TABLE memories 
        ADD COLUMN image_path VARCHAR(255)
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
  try {
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
    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
    
    const result = await pool.query(
      'INSERT INTO memories (id, title, content, date, mood, tags, image_path) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [id, title, content, date, mood, tags, imagePath]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating memory:', error);
    res.status(500).json({ error: 'An error occurred while creating the memory' });
  }
});

// Update a memory with image upload
app.put('/api/memories/:id', upload.single('image'), async (req, res) => {
  try {
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
    const memoryExists = await pool.query('SELECT id FROM memories WHERE id = $1', [id]);
    if (memoryExists.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    
    // Check if the database has the image_path column
    try {
      const columnCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'memories' AND column_name = 'image_path'
      `);
      
      if (columnCheck.rows.length === 0) {
        // Add the column if it doesn't exist
        await pool.query(`ALTER TABLE memories ADD COLUMN image_path VARCHAR(255)`);
        console.log('Added missing image_path column to memories table');
      }
    } catch (schemaError) {
      console.error('Error checking/updating schema:', schemaError);
      // Continue anyway, we'll handle potential errors later
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
    
    // Check if we need to update the image
    let imagePath;
    
    if (req.file) {
      // New image was uploaded
      imagePath = `/uploads/${req.file.filename}`;
      console.log('New image uploaded:', imagePath);
      
      try {
        // Delete old image if it exists
        const oldImageResult = await pool.query('SELECT image_path FROM memories WHERE id = $1', [id]);
        console.log('Found old image:', oldImageResult.rows[0]?.image_path);
        
        if (oldImageResult.rows.length > 0 && oldImageResult.rows[0].image_path) {
          // Remove the leading slash if present for correct path resolution
          const oldImagePath = oldImageResult.rows[0].image_path.startsWith('/') 
            ? path.join(__dirname, oldImageResult.rows[0].image_path.substring(1))
            : path.join(__dirname, oldImageResult.rows[0].image_path);
            
          console.log('Checking old image at path:', oldImagePath);
          
          if (fs.existsSync(oldImagePath)) {
            console.log('Deleting old image at path:', oldImagePath);
            fs.unlinkSync(oldImagePath);
          } else {
            console.log('Old image not found at path:', oldImagePath);
          }
        }
      } catch (error) {
        console.error('Error handling old image:', error);
        // Continue with update even if deleting old image fails
      }
    } else if (deleteImage === 'true') {
      // Delete image without replacement
      console.log('Deleting image without replacement');
      try {
        const oldImageResult = await pool.query('SELECT image_path FROM memories WHERE id = $1', [id]);
        console.log('Found image to delete:', oldImageResult.rows[0]?.image_path);
        
        if (oldImageResult.rows.length > 0 && oldImageResult.rows[0].image_path) {
          // Remove the leading slash if present for correct path resolution
          const oldImagePath = oldImageResult.rows[0].image_path.startsWith('/') 
            ? path.join(__dirname, oldImageResult.rows[0].image_path.substring(1))
            : path.join(__dirname, oldImageResult.rows[0].image_path);
            
          console.log('Checking image to delete at path:', oldImagePath);
          
          if (fs.existsSync(oldImagePath)) {
            console.log('Deleting image at path:', oldImagePath);
            fs.unlinkSync(oldImagePath);
          } else {
            console.log('Image to delete not found at path:', oldImagePath);
          }
        }
      } catch (error) {
        console.error('Error deleting image:', error);
        // Continue with update even if deleting image fails
      }
      
      imagePath = null;
    } else {
      // Keep existing image
      console.log('Keeping existing image');
      try {
        const existingImage = await pool.query('SELECT image_path FROM memories WHERE id = $1', [id]);
        imagePath = existingImage.rows[0]?.image_path || null;
        console.log('Keeping existing image:', imagePath);
      } catch (error) {
        console.error('Error getting existing image path:', error);
        imagePath = null;
      }
    }
    
    // Set default values for any missing fields
    title = title || '';
    content = content || '';
    date = date || new Date().toISOString();
    mood = mood || 'happy';
    
    console.log('Final update data:', { 
      title: title?.substring(0, 20) + '...', 
      content: content?.substring(0, 20) + '...', 
      date, 
      mood, 
      tagsLength: tags?.length, 
      imagePath, 
      id 
    });
    
    try {
      // First try a safer update without the image_path 
      const result = await pool.query(
        'UPDATE memories SET title = $1, content = $2, date = $3, mood = $4, tags = $5 WHERE id = $6 RETURNING *',
        [title, content, date, mood, tags, id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Memory not found' });
      }
      
      // Now try to update the image_path separately if needed
      if (imagePath !== undefined) {
        try {
          await pool.query(
            'UPDATE memories SET image_path = $1 WHERE id = $2',
            [imagePath, id]
          );
          result.rows[0].image_path = imagePath;
        } catch (imagePathError) {
          console.error('Error updating image_path:', imagePathError);
          // Continue without image path update
        }
      }
      
      console.log('Memory updated successfully');
      res.json(result.rows[0]);
    } catch (dbError) {
      console.error('Database error while updating memory:', dbError);
      res.status(500).json({ 
        error: 'Database error while updating the memory',
        details: dbError.message,
        code: dbError.code
      });
    }
  } catch (error) {
    console.error('Error updating memory:', error);
    res.status(500).json({ 
      error: 'An error occurred while updating the memory',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Delete a memory
app.delete('/api/memories/:id', async (req, res) => {
  const id = ensureValidUUID(req.params.id);
  
  try {
    // Get image path before deleting
    const imageResult = await pool.query('SELECT image_path FROM memories WHERE id = $1', [id]);
    const imagePath = imageResult.rows[0]?.image_path;
    
    const result = await pool.query('DELETE FROM memories WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    
    // Delete associated image if it exists
    if (imagePath) {
      // Remove the leading slash if present for correct path resolution
      const fullPath = imagePath.startsWith('/') 
        ? path.join(__dirname, imagePath.substring(1))
        : path.join(__dirname, imagePath);
        
      console.log('Checking image to delete at path:', fullPath);
      
      if (fs.existsSync(fullPath)) {
        console.log('Deleting image at path:', fullPath);
        fs.unlinkSync(fullPath);
      } else {
        console.log('Image not found at path:', fullPath);
      }
    }
    
    res.json({ message: 'Memory deleted successfully' });
  } catch (error) {
    console.error('Error deleting memory:', error);
    res.status(500).json({ 
      error: 'An error occurred while deleting the memory',
      details: error.message 
    });
  }
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}); 