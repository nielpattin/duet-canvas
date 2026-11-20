#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDataDir } from '../server/src/dataDir.ts'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const usage = (dir = resolveDataDir()) => `cduet ${pkg.version} — local tldraw canvas + MCP server

Usage: cduet [command] [options]

Commands:
  start     Start the server (default); if it already runs, print the unlock link
  stop      Stop the detached server
  status    Show whether the server answers, the link, data dir and chat state
  url       Print the unlock link
  token     Print the chat token
  rotate    Replace the chat token; use it when the token or link has leaked

Options:
  -p, --port <n>        Port to listen on (default 5858, env PORT)
      --host <h>        Host to bind (default 127.0.0.1, env HOST)
      --data-dir <dir>  Data directory (default OS data dir, env DATA_DIR)
  -d, --detach          Run in the background (start only)
  -v, --version         Print version
  -h, --help            Show this help

Environment:
  OMP_BIN       Path to the omp binary used by the in-app agent chat (default: omp)
  CLAUDE_BIN    Path to the Claude Code binary for the agent chat (default: claude)
  CODEX_BIN     Path to the Codex binary for the agent chat (default: codex)
  OPENCODE_BIN  Path to the opencode binary for the agent chat (default: opencode)
  PI_BIN        Path to the pi binary for the agent chat (default: pi)

Data dir: ${dir}`

const fail = (message, code = 1) => {
	console.error(message)
	process.exit(code)
}

let values
let positionals
try {
	;({ values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: {
			port: { type: 'string', short: 'p' },
			host: { type: 'string' },
			'data-dir': { type: 'string' },
			detach: { type: 'boolean', short: 'd' },
			version: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' },
		},
	}))
} catch (err) {
	console.error(err.message)
	console.error(usage())
	process.exit(2)
}

if (values.version) {
	console.log(pkg.version)
	process.exit(0)
}

// Flags become env before anything imports server config/auth: those read env at import time.
if (values.port) process.env.PORT = values.port
if (values.host) process.env.HOST = values.host
const dataDir = resolve(values['data-dir'] ?? resolveDataDir())
process.env.DATA_DIR = dataDir

if (values.help) {
	console.log(usage(dataDir))
	process.exit(0)
}

const port = Number(process.env.PORT ?? 5858)
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port: ${process.env.PORT}`, 2)
const host = process.env.HOST ?? '127.0.0.1'
const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
const urlHost = connectHost.includes(':') ? `[${connectHost}]` : connectHost
const baseUrl = `http://${urlHost}:${port}`

const auth = () => import('../server/src/chat/auth.ts')
const token = async () => (await auth()).chatToken()
const unlockLink = async () => `${baseUrl}/?chat=${await token()}`

const answers = async (url) => {
	try {
		await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' })
		return true
	} catch {
		return false
	}
}

const waitForServer = async (ms = 15000) => {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (await answers(`${baseUrl}/`)) return true
		await new Promise((r) => setTimeout(r, 200))
	}
	return false
}

const buildWeb = () => {
	if (existsSync(join(root, 'web/dist/index.html'))) return
	console.log('web/dist is missing, building the web app…')
	const result = spawnSync('pnpm', ['--filter', 'web', 'build'], {
		cwd: root,
		stdio: 'inherit',
		shell: process.platform === 'win32',
	})
	if (result.status !== 0) fail('web build failed; fix the errors above and retry')
}

const start = async () => {
	buildWeb()
	if (await answers(`${baseUrl}/`)) {
		const link = await unlockLink()
		console.log(`already running at ${link}`)
		return
	}
	if (values.detach) return startDetached()

	process.chdir(join(root, 'server'))
	await import('../server/src/index.ts')
	if (!(await waitForServer())) fail(`server did not answer on ${baseUrl} within 15s`)
	// The server already printed its canvas and chat links above.
	console.log(`data dir ${dataDir}`)
}

const startDetached = async () => {
	const log = join(dataDir, 'duet_canvas.log')
	mkdirSync(dataDir, { recursive: true })
	const out = openSync(log, 'a')
	const child = spawn(
		process.execPath,
		[import.meta.filename, 'start', '--port', String(port), '--host', host, '--data-dir', dataDir],
		{ cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out] },
	)
	closeSync(out)
	child.unref()
	writeFileSync(
		join(dataDir, 'daemon.json'),
		`${JSON.stringify({ pid: child.pid, port, host, log, startedAt: new Date().toISOString() }, null, '\t')}\n`,
	)
	if (!(await waitForServer())) fail(`server did not start within 15s; see ${log}`)
	const link = await unlockLink()
	console.log(`running at ${link}`)
	console.log(`pid ${child.pid}  log ${log}`)
}

const stop = () => {
	const file = join(dataDir, 'daemon.json')
	if (!existsSync(file)) {
		console.log('not running as a daemon (in the foreground, press Ctrl+C)')
		return
	}
	let info
	try {
		info = JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		fail(`cannot read ${file}`)
	}
	try {
		process.kill(info.pid)
		console.log(`stopped pid ${info.pid}`)
	} catch (err) {
		if (err.code !== 'ESRCH') fail(`could not stop pid ${info.pid}: ${err.message}`)
		console.log(`pid ${info.pid} already exited`)
	}
	rmSync(file, { force: true })
}

const chatState = async () => {
	let res
	try {
		res = await fetch(`${baseUrl}/api/chat/status`, { headers: { cookie: `canvas_chat_${port}=${await token()}` }, signal: AbortSignal.timeout(3000) })
	} catch (err) {
		return `unreachable (${err.message})`
	}
	if (!res.ok) return `unknown (HTTP ${res.status})`
	const state = await res.json()
	const detail = state.message ? `: ${state.message}` : ''
	switch (state.kind) {
		case 'ready':
			return `ready${state.version ? ` (${state.version})` : ''}`
		case 'no-omp':
			return `omp not found${detail}`
		case 'off':
			return 'off (Docker)'
		case 'locked':
			return `locked${detail}`
		default:
			return state.kind
	}
}

const status = async () => {
	const up = await answers(`${baseUrl}/`)
	console.log(`server   ${up ? 'running' : 'not running'} at ${baseUrl}`)
	if (up) console.log(`link     ${await unlockLink()}`)
	console.log(`data dir ${dataDir}`)
	const file = join(dataDir, 'daemon.json')
	if (existsSync(file)) {
		try {
			const info = JSON.parse(readFileSync(file, 'utf8'))
			let alive = true
			try {
				process.kill(info.pid, 0)
			} catch {
				alive = false
			}
			console.log(`daemon   pid ${info.pid}${alive ? '' : ' (not running)'}  log ${info.log}`)
		} catch {
			console.log(`daemon   unreadable ${file}`)
		}
	}
	if (up) console.log(`chat     ${await chatState()}`)
}

// The token file is the only copy and the server reads it on every check, so a running server needs no restart.
const rotate = async () => {
	;(await auth()).rotateToken()
	console.log(`replaced the chat token in ${dataDir}: the old one stops working and open chats disconnect within a second`)
	console.log(`link     ${await unlockLink()}`)
	// A server on another data dir keeps its own token: say so rather than leave the leaked one live.
	if ((await answers(`${baseUrl}/`)) && (await chatState()).startsWith('locked')) {
		fail(`the server at ${baseUrl} rejects the new token, so the old one still works there: it uses another data dir (pass --data-dir) or was started before this update (restart it)`)
	}
}

const command = positionals[0] ?? 'start'
if (positionals.length > 1) fail(`unexpected argument: ${positionals[1]}`, 2)

switch (command) {
	case 'start':
		await start()
		break
	case 'stop':
		stop()
		break
	case 'status':
		await status()
		break
	case 'url':
		console.log(await unlockLink())
		break
	case 'token':
		console.log(await token())
		break
	case 'rotate':
		await rotate()
		break
	default:
		console.error(`unknown command: ${command}`)
		console.error(usage(dataDir))
		process.exit(2)
}
