// 📄 src/app.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import csrf from 'csurf';
import cookieParser from 'cookie-parser';
import client from 'prom-client';
import responseTime from 'response-time';
import type { Request, Response, NextFunction } from 'express';
import { withReqId } from './utils/logger';
import { errorHandler } from './middlewares/errorHandler';
import { rateLimiter } from './middlewares/rateLimiter';
import { pingDatabase } from './lib/mongo';
import { isReady } from './config/state';
import { yellowService } from './services/yellow.service';
import apiRoutes from './routes';

const app = express();
// CORS: default deny; allow configured origins only
const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s=>s.trim()) : [];
app.use(cors({ origin: (origin, cb) => {
	if (!origin) return cb(null, true); // allow same-origin/non-browser
	if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
	return cb(new Error('Not allowed by CORS'));
}, credentials: true, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','x-csrf-token','x-viewer-address'] }));

// Helmet with tighter defaults
app.use(helmet({
	crossOriginEmbedderPolicy: false,
	contentSecurityPolicy: false,
}));

// Correlation ID middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
	const reqId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
	(req as any).reqId = reqId;
	(req as any).log = withReqId(reqId);
	// propagate to downstreams
	(_res as Response).setHeader('x-request-id', reqId);
	next();
});

// Basic sampler: log 10% of requests at info; errors always logged in errorHandler
app.use((req: Request, res: Response, next: NextFunction) => {
	const log = (req as any).log;
	const sample = Math.random() < 0.1;
	if (sample) log.info({ method: req.method, url: req.url });
	next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Needed for csurf with cookie-based secrets
app.use(cookieParser());
app.use(rateLimiter);

// Metrics (disable in tests to avoid Jest open handle leaks)
if (process.env.NODE_ENV !== 'test') {
	client.collectDefaultMetrics();
}
const httpRequestDurationMicroseconds = new client.Histogram({
	name: 'http_request_duration_ms',
	help: 'Duration of HTTP requests in ms',
	labelNames: ['method', 'route', 'code'],
	buckets: [50, 100, 300, 500, 1000, 3000]
});
app.use(responseTime((req: Request, res: Response, time: number) => {
	const route = (req as any).route?.path || req.path;
	httpRequestDurationMicroseconds.labels(req.method, route, String(res.statusCode)).observe(time);
}));
// CSRF setup with cookie-based secret so no server session is required
// Allow overriding cookie security via env for local Docker (HTTP) vs production (HTTPS)
const CSRF_SECURE = (process.env.CSRF_SECURE ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')).toLowerCase() === 'true';
const csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: 'lax', secure: CSRF_SECURE } });
const csrfBypassPaths = new Set([
	'/api/auth/login',
	'/api/auth/signup',
]);
app.use((req, res, next) => {
	const p = req.path;
	const isWebhook = p.startsWith('/api/payments/stripe/webhook')
		|| p.startsWith('/api/payments/upi/webhook')
		|| p.startsWith('/api/payments/paypal/webhook');
	const isUnsafe = ['POST','PUT','PATCH','DELETE'].includes(req.method);
	const isBrowser = !!req.headers.origin;
	if (isUnsafe && isBrowser && !isWebhook && !csrfBypassPaths.has(p)) {
		return csrfProtection(req, res, next);
	}
	return next();
});

app.use('/api', apiRoutes);
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
	let nitro: any = { ready: false };
	try {
		nitro.ready = yellowService.isReady();
		const admin = await yellowService.getAdminStatus?.();
		const status = (yellowService as any).getStatus?.() || {};
		nitro = { ...admin, ...status };
	} catch {}
	return res.status(200).json({ status: 'UP', nitrolite: nitro });
});
// CSRF token issuance for browsers: returns a one-time token bound to the secret cookie
app.get('/api/csrf', csrfProtection, (req: Request, res: Response) => {
	const token = (req as any).csrfToken?.() as string | undefined;
	if (!token) return res.status(500).json({ error: 'csrf_unavailable' });
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
			pingDatabase(),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 700))
		]);
		db = ok ? 'UP' : 'DOWN';
	} catch {
		db = 'DOWN';
	}
	let nitro: any = { ready: false };
	try {
		nitro.ready = yellowService.isReady();
		const admin = await yellowService.getAdminStatus?.();
		const status = (yellowService as any).getStatus?.() || {};
		nitro = { ...admin, ...status };
	} catch {}
	return res.status(200).json({ status: 'UP', db, nitrolite: nitro });
});
app.get('/metrics', async (_req, res) => {
	res.set('Content-Type', client.register.contentType);
	res.end(await client.register.metrics());
});
// Readiness endpoint: returns 503 until initial Mongo connect succeeded
app.get('/ready', (_req, res) => {
	const ready = isReady();
	return res.status(ready ? 200 : 503).json({ status: ready ? 'READY' : 'NOT_READY' });
});
app.use(errorHandler);
export default app;
