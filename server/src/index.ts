import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join, relative } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { getMimeType } from 'hono/utils/mime'
import { WebSocketServer } from 'ws'
import { ALLOWED_HOSTS, HOST, PORT, safeId, UPLOADS, WEB_DIST } from './config.ts'
import { buildMcpServer } from './mcp.ts'
import { closeRoom, room } from './room.ts'
import { setUiContext, UiContext } from './uiContext.ts'

const hostAllowed = (hostHeader: string | undefined) =>
	ALLOWED_HOSTS.has((hostHeader ?? '').replace(/:\d+$/, ''))

const app = new Hono()

// DNS-rebinding guard: a malicious website must not be able to reach the editing tools.
app.use('*', async (c, next) => {
	if (!hostAllowed(c.req.header('host'))) return c.text('Forbidden host', 403)
	await next()
})

app.all('/mcp', async (c) => {
	const server = buildMcpServer()
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	await server.connect(transport)
	return transport.handleRequest(c.req.raw)
})

// The browser tells us what the user has selected / is looking at.
app.post('/api/context', async (c) => {
	const parsed = UiContext.safeParse(await c.req.json())
	if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
	setUiContext(parsed.data)
	return c.json({ ok: true })
})

app.put('/uploads/:id', async (c) => {
	await writeFile(join(UPLOADS, safeId(c.req.param('id'))), Buffer.from(await c.req.arrayBuffer()))
	return c.json({ ok: true })
})
// Browsers need HTTP Range support to play and seek video, so serve uploads as partial content when asked.
app.get('/uploads/:id', async (c) => {
	const id = safeId(c.req.param('id'))
	const path = join(UPLOADS, id)
	const size = await stat(path).then((s) => s.size, () => -1)
	if (size < 0) return c.notFound()

	const headers: Record<string, string> = {
		'Content-Type': getMimeType(id) ?? 'application/octet-stream',
		'Accept-Ranges': 'bytes',
		// Uploaded SVGs must not run script in our origin.
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
		'X-Content-Type-Options': 'nosniff',
	}
	const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
	if (!range || (range[1] === '' && range[2] === '')) {
		return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, { ...headers, 'Content-Length': String(size) })
	}
	// "bytes=-N" means the last N bytes.
	const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
	const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
	if (start > end || start >= size) return c.body(null, 416, { 'Content-Range': `bytes */${size}` })
	return c.body(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, 206, {
		...headers,
		'Content-Range': `bytes ${start}-${end}/${size}`,
		'Content-Length': String(end - start + 1),
	})
})

// Production: serve the built web app. In dev, Vite serves it and proxies here.
// serveStatic resolves `root` against the cwd.
app.use('*', serveStatic({ root: relative(process.cwd(), WEB_DIST) }))

const httpServer = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
	console.log(`canvas  http://${HOST}:${info.port}`)
	console.log(`mcp     http://${HOST}:${info.port}/mcp`)
})

// WebSocket endpoint for the tldraw sync client.
const wss = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	if (url.pathname !== '/connect' || !hostAllowed(req.headers.host)) {
		socket.destroy()
		return
	}
	const sessionId = url.searchParams.get('sessionId')
	if (!sessionId) {
		socket.destroy()
		return
	}
	wss.handleUpgrade(req, socket, head, (ws) => room.handleSocketConnect({ sessionId, socket: ws }))
})

const shutdown = () => {
	closeRoom()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
