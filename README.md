# Diary Application Backend

This is a simple Express.js backend for the Diary application. It connects to a NeonTech PostgreSQL database to store and retrieve memory entries.

## Setup

1. Install dependencies
```bash
cd server
npm install
```

2. Create a `.env` file with your database connection string:
```
DATABASE_URL=postgresql://neondb_owner:npg_DABiTLX59YKE@ep-quiet-wildflower-a5prq1ph-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
PORT=3001
```

3. Start the server
```bash
npm run dev
```

## API Endpoints

- `GET /api/memories` - Get all memories
- `GET /api/memories/:id` - Get a specific memory
- `POST /api/memories` - Create a new memory
- `PUT /api/memories/:id` - Update an existing memory
- `DELETE /api/memories/:id` - Delete a memory

## Database Schema

The application uses a single table `memories` with the following structure:
- `id` - UUID (Primary Key)
- `title` - VARCHAR(255)
- `content` - TEXT
- `date` - TIMESTAMP WITH TIME ZONE
- `mood` - VARCHAR(50)
- `tags` - TEXT[] 