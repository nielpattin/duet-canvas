import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DATA_DIR } from './config.ts'

// What the user is looking at. This is per-user UI state, not part of the synced document,
// so the browser pushes it here and we keep the last value (persisted across restarts).
export const UiContext = z.object({
	selectedShapeIds: z.array(z.string()),
	currentPageId: z.string(),
	viewport: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
	updatedAt: z.number().optional(),
})
export type UiContext = z.infer<typeof UiContext>

const FILE = join(DATA_DIR, 'ui-context.json')

let current: UiContext | null = null
if (existsSync(FILE)) {
	const parsed = UiContext.safeParse(JSON.parse(readFileSync(FILE, 'utf8')))
	if (parsed.success) current = parsed.data
}

export function getUiContext() {
	return current
}

export function setUiContext(next: UiContext) {
	current = { ...next, updatedAt: Date.now() }
	writeFileSync(FILE, JSON.stringify(current))
}
