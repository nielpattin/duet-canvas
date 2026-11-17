import { StateNode, type TLShape } from 'tldraw'
import { canTarget, createMark, isRegion } from './marks.ts'

// The Mark tool: pick it, then click any shape, image or agent block to leave the agent a note about it.
// Clicking empty canvas leaves a free-floating note.
class MarkIdle extends StateNode {
	static override id = 'idle'

	override onEnter() {
		this.editor.setCursor({ type: 'cross', rotation: 0 })
	}

	override onPointerDown() {
		const point = this.editor.inputs.getCurrentPagePoint()
		// The dashed box of an earlier mark must not hide the shape inside it.
		const hit: TLShape | undefined = this.editor.getShapeAtPoint(point, { hitInside: true, margin: 6, renderingOnly: true, filter: (s) => !isRegion(s) })
		// Leave the tool first: switching tools after creating the note would drop its text editing.
		this.editor.setCurrentTool('select')
		createMark(this.editor, hit && canTarget(hit) ? [hit] : [], point)
	}
}

export class MarkTool extends StateNode {
	static override id = 'mark'
	static override initial = 'idle'
	static override children = () => [MarkIdle]
}
