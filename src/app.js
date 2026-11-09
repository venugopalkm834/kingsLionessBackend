
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware');
const app = express();

app.set('trust proxy', 1);

app.use(helmet({
    crossOriginResourcePolicy: {
        policy: 'cross-origin'
    }
}));

// CORS configuration
const allowedOrigins = [
    'http://localhost:4200',
    'https://kingslionessfrontend.onrender.com'
];

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
}));
app.use(express.json({ limit: '1mb' }));

if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
}
require('fs').mkdirSync(path.join(__dirname, '../uploads'), { recursive: true });
app.use('/uploads', express.static(
    path.join(__dirname, '../uploads'),
    {
        setHeaders: (r) => r.set('X-Content-Type-Options', 'nosniff')
    }
));

app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

// API routes
app.use('/api/auth', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100
}), require('./routes/auth'));

app.use('/api/admin', require('./routes/admin'));

app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 300
}), require('./routes/user'));

// 404 handler
app.use((req, res) => {
    res.status(404).json({ message: 'Not found' });
});

// Error handler
app.use(errorHandler);

module.exports = app;
