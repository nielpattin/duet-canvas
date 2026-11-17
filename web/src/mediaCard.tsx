import { SparkIcon } from './icons.tsx'
import { createShapeId,
	HTMLContainer,
	Rectangle2d,
	resizeBox,
	ShapeUtil,
	stopEventPropagation,
	T,
	useEditor,
	useValue,
	type Editor,
	type TLAssetId,
	type TLBaseShape,
	type TLResizeInfo,
	type TLShape,
} from 'tldraw'

// One shape for an image, GIF or video together with its caption, so the caption can never be left behind.
// The server defines the same shape (server/src/mediaCard.ts): keep the two in sync, the sync room rejects a mismatch.
export const MEDIA_CARD = 'media-card'

/** Height of the caption strip under the picture. */
export const CAPTION_H = 48

export interface MediaCardProps {
	/** Picture width. */
	w: number
	/** Picture height (the caption strip comes on top of this). */
	h: number
	kind: 'image' | 'video'
	/** Where the file is served from, e.g. /uploads/<uuid>-name.png */
	src: string
	mimeType: string
	name: string
	caption: string
}

declare module 'tldraw' {
	interface TLGlobalShapePropsMap {
		'media-card': MediaCardProps
	}
}

export type MediaCardShape = TLBaseShape<typeof MEDIA_CARD, MediaCardProps>

function focusSoon(el: HTMLTextAreaElement | null) {
	if (!el) return
	el.focus()
	setTimeout(() => {
		el.focus()
		el.setSelectionRange(el.value.length, el.value.length)
	}, 60)
}

function MediaCardView({ shape }: { shape: MediaCardShape }) {
	const editor = useEditor()
	const isEditing = useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
	const isSelected = useValue('selected', () => editor.getOnlySelectedShapeId() === shape.id, [editor, shape.id])
	const { w, h, kind, src, caption, name } = shape.props
	const byAgent = (shape.meta as { author?: string }).author === 'agent'

	const setCaption = (value: string) => editor.updateShape<MediaCardShape>({ id: shape.id, type: MEDIA_CARD, props: { caption: value } })

	return (
		<HTMLContainer style={{ width: w, height: h + CAPTION_H, pointerEvents: 'all' }}>
			<div style={{ width: w, height: h, background: '#f1f1f1', borderRadius: 6, overflow: 'hidden' }}>
				{kind === 'image' ? (
					<img src={src} alt={caption || name} draggable={false} style={{ width: '100%', height: '100%', display: 'block' }} />
				) : (
					// Controls only once selected, so the first click selects the card instead of playing the video.
					<video
						src={src}
						controls={isSelected}
						loop
						muted
						playsInline
						preload="metadata"
						onPointerDown={isSelected ? stopEventPropagation : undefined}
						style={{ width: '100%', height: '100%', display: 'block', background: 'black' }}
					/>
				)}
			</div>
			<div style={{ height: CAPTION_H, padding: '6px 2px 0', font: '500 14px/1.3 system-ui, sans-serif', color: '#222', overflow: 'hidden' }}>
				{isEditing ? (
					<textarea
						// The double-click that opened the editor is still finishing, and its pointer-up takes focus
						// away, so focus again once it has settled. (No onBlur: clicking the canvas ends editing already.)
						ref={focusSoon}
						value={caption}
						onChange={(e) => setCaption(e.target.value)}
						onPointerDown={stopEventPropagation}
						onKeyDown={(e) => {
							e.stopPropagation()
							if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
								e.preventDefault()
								editor.setEditingShape(null)
							}
						}}
						style={{ width: '100%', height: '100%', resize: 'none', border: '1px solid #bbb', borderRadius: 4, font: 'inherit', padding: 4, boxSizing: 'border-box' }}
					/>
				) : (
					<>
						{byAgent && (
							<span title="Added by the agent" style={{ color: '#6d4aff', marginRight: 6, display: 'inline-flex', verticalAlign: '-1px' }}>
								<SparkIcon size={14} />
							</span>
						)}
						{caption || (isSelected && <span style={{ color: '#999' }}>Double-click to add a caption</span>)}
					</>
				)}
			</div>
		</HTMLContainer>
	)
}

export class MediaCardShapeUtil extends ShapeUtil<MediaCardShape> {
	static override type = MEDIA_CARD
	static override props = {
		w: T.number,
		h: T.number,
		kind: T.literalEnum('image', 'video'),
		src: T.string,
		mimeType: T.string,
		name: T.string,
		caption: T.string,
	}

	override getDefaultProps(): MediaCardProps {
		return { w: 320, h: 240, kind: 'image', src: '', mimeType: '', name: '', caption: '' }
	}

	override canEdit() {
		return true
	}
	override isAspectRatioLocked() {
		return true
	}

	override getGeometry(shape: MediaCardShape) {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h + CAPTION_H, isFilled: true })
	}

	// Resize the picture and keep its proportions; the caption strip stays a fixed height.
	override onResize(shape: MediaCardShape, info: TLResizeInfo<MediaCardShape>) {
		const resized = resizeBox(shape, info, { minWidth: 80, minHeight: 80 })
		const w = resized.props?.w ?? shape.props.w
		return { ...resized, props: { ...resized.props, w, h: Math.round((w * shape.props.h) / shape.props.w) } }
	}

	override component(shape: MediaCardShape) {
		return <MediaCardView shape={shape} />
	}

	override getIndicatorPath(shape: MediaCardShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h + CAPTION_H)
		return path
	}
}

// Turns pictures the user drops, pastes or inserts into media cards, so they get captions too.
// tldraw creates the asset with an empty src and fills it in once the upload finishes, so convert at that point.
export function convertUserMediaToCards(editor: Editor) {
	const convert = (shape: TLShape) => {
		if (shape.type !== 'image' && shape.type !== 'video') return
		if ((shape.meta as { author?: string }).author) return // the agent's own pictures are already cards
		const assetId = (shape.props as { assetId?: TLAssetId | null }).assetId
		const asset = assetId ? editor.getAsset(assetId) : undefined
		if (!asset || (asset.type !== 'image' && asset.type !== 'video') || !asset.props.src) return
		const { src, name, mimeType } = asset.props
		const { w, h } = shape.props as { w: number; h: number }
		const id = createShapeId()
		// Swap after the current change finishes: a shape cannot be replaced inside its own update.
		queueMicrotask(() =>
			editor.run(() => {
				editor.deleteShape(shape.id)
				editor.createShape({
					id,
					type: MEDIA_CARD,
					x: shape.x,
					y: shape.y,
					rotation: shape.rotation,
					parentId: shape.parentId,
					index: shape.index,
					props: { w, h, kind: asset.type, src, name, mimeType: mimeType ?? '', caption: '' },
				} as const)
				editor.select(id)
			})
		)
	}

	const stopShapes = editor.sideEffects.registerAfterCreateHandler('shape', convert)
	const stopAssets = editor.sideEffects.registerAfterChangeHandler('asset', (_prev, next) => {
		if (next.type !== 'image' && next.type !== 'video') return
		if (!next.props.src) return
		for (const shape of editor.getCurrentPageShapes()) {
			if ((shape.props as { assetId?: string | null }).assetId === next.id) convert(shape)
		}
	})
	return () => {
		stopShapes()
		stopAssets()
	}
}
