# JobPoper Backend API

A Node.js backend API for JobPoper application with MongoDB integration.

## Features

- Express.js server with middleware
- MongoDB connection with Mongoose
- Environment configuration
- Health check endpoints
- Database connection testing
- Error handling
- CORS support

## Project Structure

```
jobpoper_backend/
├── config/
│   └── database.js          # MongoDB connection configuration
├── controllers/
│   └── authController.js    # Authentication controllers
├── middleware/
│   └── errorHandler.js      # Error handling middleware
├── models/
│   └── User.js              # User model
├── routes/
│   ├── auth.js              # Authentication routes
│   ├── health.js            # Health check routes
│   └── users.js             # User routes
├── utils/                    # Utility functions
├── .env                      # Environment variables
├── .env.example             # Environment variables template
├── package.json             # Dependencies and scripts
└── server.js                # Main server file
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables:
   - Copy `.env.example` to `.env`
   - Update the MongoDB connection string in `.env`

3. Start the server:
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm start
   ```

## Environment Variables

- `PORT`: Server port (default: 5000)
- `NODE_ENV`: Environment (development/production)
- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: JWT secret key
- `CORS_ORIGIN`: CORS allowed origin

## API Endpoints

### Health Check
- `GET /` - Basic server status
- `GET /api/health` - Detailed health check
- `GET /api/health/db` - Database connection test

### Authentication (Coming Soon)
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login

### Users (Coming Soon)
- `GET /api/users` - Get users

## Database Connection

The application automatically connects to MongoDB on startup. You can test the connection using:

```bash
curl http://localhost:5000/api/health/db
```

## Development

- Uses nodemon for auto-restart during development
- Environment variables loaded from `.env` file
- CORS enabled for frontend integration
- Comprehensive error handling
