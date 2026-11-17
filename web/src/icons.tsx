import type { JSX } from 'react'

// One icon set for the whole app: 16px grid, 1.6 round strokes, colour from the surrounding text (currentColor).
type Props = { size?: number }
const svg = (size: number, children: JSX.Element) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
		{children}
	</svg>
)

export const CloseIcon = ({ size = 14 }: Props) => svg(size, <path d="M4 4l8 8M12 4l-8 8" />)
export const ChevronDownIcon = ({ size = 12 }: Props) => svg(size, <path d="M4 6l4 4 4-4" />)
export const CheckIcon = ({ size = 12 }: Props) => svg(size, <path d="M3.5 8.5l3 3 6-7" />)
export const DashIcon = ({ size = 12 }: Props) => svg(size, <path d="M4 8h8" />)
export const PaperclipIcon = ({ size = 16 }: Props) => svg(size, <path d="M13.5 7.5 8 13a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.4 11.4a1 1 0 0 1-1.5-1.4L10 4.9" />)
// Four-point star, filled: marks what the agent wrote.
export const SparkIcon = ({ size = 12 }: Props) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
		<path d="M8 1.2c.5 3.6 1.7 5.4 6.8 6.8-5.1 1.4-6.3 3.2-6.8 6.8-.5-3.6-1.7-5.4-6.8-6.8C6.3 6.6 7.5 4.8 8 1.2Z" />
	</svg>
)
