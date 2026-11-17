import { react, type Editor } from 'tldraw'

const DEBOUNCE_MS = 250

// Selection and viewport are per-user UI state, so they never reach the server through document sync.
// Push them to the server so the coding agent can see what the user is looking at, even after the tab closes.
// Returns a cleanup function (use as the `onMount` return value).
export function pushContextToServer(editor: Editor) {
	let timer: ReturnType<typeof setTimeout> | undefined

	const stop = react('push context to server', () => {
		const body = JSON.stringify({
			selectedShapeIds: editor.getSelectedShapeIds(),
			currentPageId: editor.getCurrentPageId(),
			viewport: editor.getViewportPageBounds().toJson(),
		})
		clearTimeout(timer)
		timer = setTimeout(() => {
			void fetch('/api/context', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				keepalive: true,
			})
		}, DEBOUNCE_MS)
	})

	return () => {
		stop()
		clearTimeout(timer)
	}
}
