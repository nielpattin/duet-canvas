import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join, relative } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { getMimeType } from 'hono/utils/mime'
import { WebSocketServer } from 'ws'
import { ALLOWED_HOSTS, HOST, IN_DOCKER, PORT, safeId, UPLOADS, WEB_DIST } from './config.ts'
import { chatToken, tokenOk } from './chat/auth.ts'
import { detectAgents } from './chat/agents.ts'
import { ChatHub } from './chat/hub.ts'
import { buildMcpServer } from './mcp.ts'
import { closeRoom, room } from './room.ts'
import { migrateAnsweredMarks, migrateArrowsBehind, migrateLegacyMarks } from './shapes.ts'
import { setUiContext, UiContext } from './uiContext.ts'

migrateLegacyMarks()
migrateArrowsBehind()
migrateAnsweredMarks()

const hostAllowed = (hostHeader: string | undefined) =>
	ALLOWED_HOSTS.has((hostHeader ?? '').replace(/:\d+$/, ''))

// A page on another origin must not be able to open the chat socket: whoever can prompt omp can drive this machine.
// Non-browser clients send no Origin and are already local.
const originAllowed = (origin: string | undefined) => {
	if (!origin) return true
	try {
		return ALLOWED_HOSTS.has(new URL(origin).hostname)
	} catch {
		return false
	}
}

// Chat drives the user's own omp, so it only exists for a native run, never in the container.
const chat = IN_DOCKER ? undefined : new ChatHub()

// The browser holds the chat token as an HttpOnly cookie. Cookies ignore the port, so one unlock also covers the Vite
// dev server on the same host; the server's port is in the name so two servers on one host do not overwrite each other.
const CHAT_COOKIE = `canvas_chat_${PORT}`
const chatCookie = (header: string | undefined) => new RegExp(`(?:^|;\\s*)${CHAT_COOKIE}=([^;]*)`).exec(header ?? '')?.[1]

const app = new Hono()

// DNS-rebinding guard: a malicious website must not be able to reach the editing tools.
app.use('*', async (c, next) => {
	if (!hostAllowed(c.req.header('host'))) return c.text('Forbidden host', 403)
	await next()
})

app.all('/mcp', async (c) => {
	const server = buildMcpServer(new URL(c.req.url).origin)
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})
	await server.connect(transport)
	return transport.handleRequest(c.req.raw)
})

app.get('/api/chat/status', async (c) => {
	if (!chat) return c.json({ kind: 'off' })
	if (!tokenOk(getCookie(c, CHAT_COOKIE))) return c.json({ kind: 'locked' })
	const agents = await detectAgents()
	if (agents.some((a) => a.ok)) return c.json({ kind: 'ready', agents })
	return c.json({ kind: 'no-agent', message: 'No chat agent found. Install omp, Claude Code, Codex, opencode or pi (or set OMP_BIN, CLAUDE_BIN, CODEX_BIN, OPENCODE_BIN, PI_BIN).', agents })
})

// Swaps the code from the unlock link (or pasted into the chat panel) for the cookie.
app.post('/api/chat/unlock', async (c) => {
	const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null
	const token = typeof body?.token === 'string' ? body.token : undefined
	if (!chat || !tokenOk(token)) return c.json({ ok: false }, 403)
	setCookie(c, CHAT_COOKIE, token!, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 400 * 24 * 60 * 60 })
	return c.json({ ok: true })
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
	// The link that unlocks the agent chat in a browser (it swaps the code for a cookie on first visit).
	// Not when stdout is a file (the detached CLI's log): `duet-canvas url` prints it.
	if (chat) console.log(`chat    http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${info.port}/${process.stdout.isTTY ? `?chat=${chatToken()}` : ''}`)
})

// WebSocket endpoint for the tldraw sync client.
const wss = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	if (url.pathname === '/chat' && chat && hostAllowed(req.headers.host) && originAllowed(req.headers.origin) && tokenOk(chatCookie(req.headers.cookie))) {
		wss.handleUpgrade(req, socket, head, (ws) => chat.add(ws))
		return
	}
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
	chat?.dispose()
	closeRoom()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
