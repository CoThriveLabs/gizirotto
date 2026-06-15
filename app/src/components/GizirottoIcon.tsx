type Anim = 'none' | 'think' | 'pop'

interface Props {
  /** px サイズ（幅=高さ）。インライン絵文字置換は 20 前後、思考中アイコンは 40-48 想定。 */
  size?: number
  /** none=静止 / think=ふわふわ上下 / pop=出現時ぴょこん */
  anim?: Anim
  className?: string
}

const animClass: Record<Anim, string> = {
  none: '',
  think: 'gizirotto-think',
  pop: 'gizirotto-pop',
}

export function GizirottoIcon({ size = 24, anim = 'none', className = '' }: Props) {
  return (
    <img
      src="/character/gizirotto.svg"
      alt="ぎじろっと"
      width={size}
      height={size}
      aria-hidden="true"
      draggable={false}
      className={`inline-block select-none align-text-bottom ${animClass[anim]} ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
