import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Native runs keep their data in the user's OS data dir; Docker sets DATA_DIR=/data.
// Read at call time so the CLI can set DATA_DIR from a flag first.
export function resolveDataDir(): string {
	if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR)
	const home = homedir()
	const base =
		process.platform === 'win32'
			? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
			: process.platform === 'darwin'
				? join(home, 'Library', 'Application Support')
				: (process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'))
	// Before the rename to duet-canvas the folder was canvas-idea: keep using it so an existing canvas is not orphaned.
	const legacy = join(base, 'canvas-idea')
	return existsSync(legacy) && !existsSync(join(base, 'duet-canvas')) ? legacy : join(base, 'duet-canvas')
}
