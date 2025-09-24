"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// 📄 src/app.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const crypto_1 = __importDefault(require("crypto"));
const csurf_1 = __importDefault(require("csurf"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const prom_client_1 = __importDefault(require("prom-client"));
const response_time_1 = __importDefault(require("response-time"));
const logger_1 = require("./utils/logger");
const errorHandler_1 = require("./middlewares/errorHandler");
const rateLimiter_1 = require("./middlewares/rateLimiter");
const mongo_1 = require("./lib/mongo");
const state_1 = require("./config/state");
const yellow_service_1 = require("./services/yellow.service");
const routes_1 = __importDefault(require("./routes"));
const app = (0, express_1.default)();
// CORS: default deny; allow configured origins only
const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : [];
app.use((0, cors_1.default)({ origin: (origin, cb) => {
        if (!origin)
            return cb(null, true); // allow same-origin/non-browser
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin))
            return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    }, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-viewer-address'] }));
// Helmet with tighter defaults
app.use((0, helmet_1.default)({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
}));
// Correlation ID middleware
app.use((req, _res, next) => {
    const reqId = req.headers['x-request-id'] || crypto_1.default.randomUUID();
    req.reqId = reqId;
    req.log = (0, logger_1.withReqId)(reqId);
    // propagate to downstreams
    _res.setHeader('x-request-id', reqId);
    next();
});
// Basic sampler: log 10% of requests at info; errors always logged in errorHandler
app.use((req, res, next) => {
    const log = req.log;
    const sample = Math.random() < 0.1;
    if (sample)
        log.info({ method: req.method, url: req.url });
    next();
});
app.use(express_1.default.json({ limit: '1mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '1mb' }));
// Needed for csurf with cookie-based secrets
app.use((0, cookie_parser_1.default)());
app.use(rateLimiter_1.rateLimiter);
// Metrics (disable in tests to avoid Jest open handle leaks)
if (process.env.NODE_ENV !== 'test') {
    prom_client_1.default.collectDefaultMetrics();
}
const httpRequestDurationMicroseconds = new prom_client_1.default.Histogram({
    name: 'http_request_duration_ms',
    help: 'Duration of HTTP requests in ms',
    labelNames: ['method', 'route', 'code'],
    buckets: [50, 100, 300, 500, 1000, 3000]
});
app.use((0, response_time_1.default)((req, res, time) => {
    const route = req.route?.path || req.path;
    httpRequestDurationMicroseconds.labels(req.method, route, String(res.statusCode)).observe(time);
}));
// CSRF setup with cookie-based secret so no server session is required
// Allow overriding cookie security via env for local Docker (HTTP) vs production (HTTPS)
const CSRF_SECURE = (process.env.CSRF_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')).toLowerCase() === 'true';
const csrfProtection = (0, csurf_1.default)({ cookie: { httpOnly: true, sameSite: 'lax', secure: CSRF_SECURE } });
const csrfBypassPaths = new Set([
    '/api/auth/login',
    '/api/auth/signup',
]);
app.use((req, res, next) => {
    const p = req.path;
    const isWebhook = p.startsWith('/api/payments/stripe/webhook')
        || p.startsWith('/api/payments/upi/webhook')
        || p.startsWith('/api/payments/paypal/webhook');
    const isUnsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isBrowser = !!req.headers.origin;
    if (isUnsafe && isBrowser && !isWebhook && !csrfBypassPaths.has(p)) {
        return csrfProtection(req, res, next);
    }
    return next();
});
app.use('/api', routes_1.default);
// API root info for convenience
app.get('/api', (_req, res) => {
    return res.status(200).json({
        ok: true,
        name: 'StreamFi API',
        docs: '/docs',
        health: '/health',
        examples: ['/api/auth/login', '/api/csrf'],
    });
});
// Explicit API health endpoint for tooling
app.get('/api/health', async (_req, res) => {
    let nitro = { ready: false };
    try {
        nitro.ready = yellow_service_1.yellowService.isReady();
        const admin = await yellow_service_1.yellowService.getAdminStatus?.();
        const status = yellow_service_1.yellowService.getStatus?.() || {};
        nitro = { ...admin, ...status };
    }
    catch { }
    return res.status(200).json({ status: 'UP', nitrolite: nitro });
});
// CSRF token issuance for browsers: returns a one-time token bound to the secret cookie
app.get('/api/csrf', csrfProtection, (req, res) => {
    const token = req.csrfToken?.();
    if (!token)
        return res.status(500).json({ error: 'csrf_unavailable' });
    res.setHeader('x-csrf-token', token);
    return res.json({ csrfToken: token });
});
// Root info endpoint (useful for platform health checks like Render)
app.get('/', (_req, res) => {
    return res.status(200).json({
        name: 'StreamFi API',
        status: 'UP',
        health: '/health',
        apiBase: '/api',
    });
});
app.get('/health', async (_req, res) => {
    let db = 'UNKNOWN';
    try {
        const ok = await Promise.race([
            (0, mongo_1.pingDatabase)(),
            new Promise((resolve) => setTimeout(() => resolve(false), 700))
        ]);
        db = ok ? 'UP' : 'DOWN';
    }
    catch {
        db = 'DOWN';
    }
    let nitro = { ready: false };
    try {
        nitro.ready = yellow_service_1.yellowService.isReady();
        const admin = await yellow_service_1.yellowService.getAdminStatus?.();
        const status = yellow_service_1.yellowService.getStatus?.() || {};
        nitro = { ...admin, ...status };
    }
    catch { }
    return res.status(200).json({ status: 'UP', db, nitrolite: nitro });
});
app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', prom_client_1.default.register.contentType);
    res.end(await prom_client_1.default.register.metrics());
});
// Readiness endpoint: returns 503 until initial Mongo connect succeeded
app.get('/ready', (_req, res) => {
    const ready = (0, state_1.isReady)();
    return res.status(ready ? 200 : 503).json({ status: ready ? 'READY' : 'NOT_READY' });
});
app.use(errorHandler_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map