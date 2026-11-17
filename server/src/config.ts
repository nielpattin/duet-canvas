import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PORT = Number(process.env.PORT ?? 5858)
// Bind to loopback by default. The MCP tools can edit the canvas, so never expose this unauthenticated.
export const HOST = process.env.HOST ?? '127.0.0.1'
export const DATA_DIR = resolve(process.env.DATA_DIR ?? '.data')
export const WEB_DIST = resolve(import.meta.dirname, '../../web/dist')
// Host headers we accept (DNS-rebinding protection). Add more via ALLOWED_HOSTS=a,b
export const ALLOWED_HOSTS = new Set([
	'localhost',
	'127.0.0.1',
	'[::1]',
	...(process.env.ALLOWED_HOSTS?.split(',').map((h) => h.trim()) ?? []),
])

mkdirSync(DATA_DIR, { recursive: true })

export const UPLOADS = join(DATA_DIR, 'uploads')
mkdirSync(UPLOADS, { recursive: true })
export const safeId = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, '_')
