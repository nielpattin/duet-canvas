import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import type { Detected } from './driver.ts'

export type Child = ChildProcessByStdio<Writable, Readable, Readable>

// Windows cannot spawn the .cmd shims that npm and pnpm create (codex, opencode) directly, so we find the file the
// way cmd.exe would and run shims through cmd.exe. Arguments must not contain double quotes.
function winFile(bin: string): string {
	const dirs = /[\\/]/.test(bin) ? [''] : (process.env.PATH ?? '').split(delimiter)
	for (const dir of dirs) {
		const base = dir ? join(dir, bin) : bin
		if (/\.(exe|cmd|bat)$/i.test(base) && existsSync(base)) return base
		for (const ext of ['.exe', '.cmd', '.bat']) if (existsSync(base + ext)) return base + ext
	}
	return bin
}
const quote = (a: string) => (a === '' || /[\s&|<>^%()]/.test(a) ? `"${a}"` : a)

// windowsHide: the daemon has no console, so on Windows the CLI would otherwise open a terminal window of its own.
export function launch(bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Child {
	const o = { ...opts, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }
	if (process.platform !== 'win32') return spawn(bin, args, o)
	const file = winFile(bin)
	if (!/\.(cmd|bat)$/i.test(file)) return spawn(file, args, o)
	return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], { ...o, windowsVerbatimArguments: true })
}

// A shim's cmd.exe does not pass a plain kill on to the real process, so on Windows the whole tree goes.
export function killTree(child: Child) {
	if (child.exitCode !== null || !child.pid) return
	if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {})
	else child.kill()
}

export function detectCli(name: string, bin: string, envVar: string): Promise<Detected> {
	const { promise, resolve } = Promise.withResolvers<Detected>()
	const fail = (why: string) => resolve({ ok: false, message: `Could not run "${bin}" (${why}). Install ${name} or set ${envVar}.` })
	const child = launch(bin, ['--version'])
	let out = ''
	const timer = setTimeout(() => (killTree(child), fail('timed out')), 15_000)
	child.stdout.on('data', (d) => (out += d))
	child.stderr.resume()
	child.stdin.on('error', () => {})
	child.stdin.end()
	child.on('error', (e) => (clearTimeout(timer), fail(e.message)))
	child.on('close', (code) => {
		clearTimeout(timer)
		// opencode colors its --version output even when piped.
		const version = stripVTControlCharacters(out).trim().split(/\r?\n/).pop() ?? ''
		if (code === 0 && version) resolve({ ok: true, version })
		else fail(`exit code ${code}`)
	})
	return promise
}
