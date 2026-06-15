import { Fragment, type ReactNode } from 'react'
import { GizirottoIcon } from '@/components/GizirottoIcon'

/**
 * 笑顔系絵文字を最大 N 個まで GizirottoIcon に置換する。
 *
 * 対象（笑顔系のみ）:
 *   - U+1F600〜U+1F60F: 😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏
 *     （笑顔系として 😀-😍 を採用。😈😎 等は表情系で許容範囲内とする）
 *   - U+263A ☺（VS16 ☺️ 含む）
 *   - U+1F970 🥰
 * それ以外の絵文字（泣き顔・物・記号等）は対象外で素通し。
 * 3 個目以降の笑顔絵文字は元の絵文字のまま残す。
 */
const SMILE_RE =
  /[\u{1F600}-\u{1F60F}]|\u{1F970}|☺️?/gu

const MAX_REPLACE = 2

export function renderWithGizirotto(text: string): ReactNode {
  if (!text) return text

  const matches = [...text.matchAll(SMILE_RE)]
  if (matches.length === 0) return text

  const out: ReactNode[] = []
  let cursor = 0
  let replaced = 0

  for (const m of matches) {
    const start = m.index
    if (replaced >= MAX_REPLACE) break
    if (start > cursor) out.push(text.slice(cursor, start))
    out.push(
      <GizirottoIcon
        key={`gz-${start}`}
        size={20}
        className="mx-px"
      />,
    )
    cursor = start + m[0].length
    replaced += 1
  }
  if (cursor < text.length) out.push(text.slice(cursor))

  return (
    <>
      {out.map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </>
  )
}
