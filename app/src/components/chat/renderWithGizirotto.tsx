import { Fragment, type ReactNode } from 'react'
import { GizirottoIcon } from '@/components/GizirottoIcon'

/**
 * 笑顔系絵文字を GizirottoIcon に置換する。会話全体で合計 maxTotal 個までという上限を
 * 呼び出し側（ChatView）が複数メッセージにまたがって管理できるよう、「これまで何個
 * 使ったか」を alreadyUsed として受け取り、「このテキストで何個使ったか」を返り値の
 * usedInThisText に含める（呼び出し側は累積してから次のメッセージへ渡す）。
 *
 * 対象（笑顔系のみ）:
 *   - U+1F600〜U+1F60F: 😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏
 *     （笑顔系として 😀-😍 を採用。😈😎 等は表情系で許容範囲内とする）
 *   - U+263A ☺（VS16 ☺️ 含む）
 *   - U+1F970 🥰
 * それ以外の絵文字（泣き顔・物・記号等）は対象外で素通し。
 * 会話全体で maxTotal 個を超えた分は元の絵文字のまま残す。
 */
const SMILE_RE = /[\u{1F600}-\u{1F60F}]|\u{1F970}|☺️?/gu

export const GIZIROTTO_MAX_TOTAL = 2

export interface GizirottoRenderResult {
  node: ReactNode
  usedInThisText: number
}

export function renderWithGizirotto(
  text: string,
  alreadyUsed: number,
  maxTotal: number = GIZIROTTO_MAX_TOTAL,
): GizirottoRenderResult {
  const remaining = Math.max(0, maxTotal - alreadyUsed)
  if (!text || remaining === 0) return { node: text, usedInThisText: 0 }

  const matches = [...text.matchAll(SMILE_RE)]
  if (matches.length === 0) return { node: text, usedInThisText: 0 }

  const out: ReactNode[] = []
  let cursor = 0
  let replaced = 0

  for (const m of matches) {
    const start = m.index
    if (replaced >= remaining) break
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

  return {
    node: (
      <>
        {out.map((node, i) => (
          <Fragment key={i}>{node}</Fragment>
        ))}
      </>
    ),
    usedInThisText: replaced,
  }
}
