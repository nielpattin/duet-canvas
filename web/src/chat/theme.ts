import { useSyncExternalStore } from 'react'

// The chat panel lives outside <Tldraw>, so it cannot read tldraw's theme from context. App's onMount feeds it in
// (setDarkMode) from the editor's user preference, which also covers "system" and live changes.
function guessDark() {
	try {
		for (const key of Object.keys(localStorage)) {
			if (!key.startsWith('TLDRAW_USER_DATA')) continue
			const scheme = JSON.parse(localStorage.getItem(key) ?? '{}')?.user?.colorScheme
			if (scheme === 'dark') return true
			if (scheme === 'system') return matchMedia('(prefers-color-scheme: dark)').matches
		}
	} catch {
		// unreadable preference: fall through to light
	}
	return false
}

// The guess only avoids a light flash before the editor mounts; the editor's value replaces it right after.
let dark = guessDark()
const listeners = new Set<() => void>()

export function setDarkMode(value: boolean) {
	if (value === dark) return
	dark = value
	for (const l of listeners) l()
}

export const useDarkMode = () =>
	useSyncExternalStore(
		(l) => (listeners.add(l), () => listeners.delete(l)),
		() => dark
	)
