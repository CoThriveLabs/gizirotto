/**
 * builtin サンプルテンプレ 3 種の静的サムネ PNG を生成する。
 *
 * 背景:
 *   builtin（家族会議 / 子の予定 / 家計報告）は family_id=null のため image_cache RLS の
 *   都合でユーザーテンプレ用サムネ生成パイプ（template-thumbnail.ts / image_cache）を
 *   流用できない（mistake.md R9 「等価移植元の判定ミス」: 入力データ質が docx ベースで
 *   PDF 1段保存テンプレと異なる）。
 *
 *   よって UI からアクセス可能な静的 PNG として public/builtin-templates/ に bundle する。
 *
 * 使い方（一回きり・成果物はコミットする）:
 *   pnpm tsx scripts/build-builtin-template-thumbs.ts
 *
 * 出力先:
 *   public/builtin-templates/family-meeting.png
 *   public/builtin-templates/child-schedule.png
 *   public/builtin-templates/budget-report.png
 *
 * 依存: 既存 @playwright/test の chromium を再利用（追加 dep なし）。
 */
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'builtin-templates')

// A4 縦の比率 1:1.414。カード側 aspectRatio: '1 / 1.414' と完全一致させる。
// 解像度: dpi72 相当の従来テンプレサムネ (~595x842) と揃える。
const WIDTH = 595
const HEIGHT = 842

type BuiltinSpec = {
  slug: string
  name: string
  date: string
  // label は HTML 表示用日本語。fieldName は templates.fields の name（seed.sql 互換）。
  // bbox JSON は fieldName をキーにして minutes.bbox_overrides 焼き込みと完全一致させる。
  rows: { label: string; fieldName: string; value: string }[]
}

const SPECS: BuiltinSpec[] = [
  {
    slug: 'family-meeting',
    name: '家族会議',
    date: '2026年 6月10日',
    rows: [
      { label: '参加者', fieldName: 'attendees', value: 'パパ ／ ママ ／ 長女 ／ 長男' },
      { label: '議題', fieldName: 'agenda', value: '夏休みの旅行先 ／ 習い事の見直し ／ 家事分担の再調整' },
      {
        label: '議事内容',
        fieldName: 'discussion',
        value:
          '・旅行は子どもたちの希望をふまえて北海道で確定。\n・習い事は長女の英会話、長男の水泳を継続候補に。\n・平日の朝食準備をパパ担当に変更する案を検討。',
      },
      { label: '決定事項', fieldName: 'decisions', value: '7月下旬に北海道へ。8月から英会話を開始。' },
      { label: 'TODO', fieldName: 'todos', value: '航空券の予約 ／ 英会話の体験申込 ／ 家事分担表の更新' },
    ],
  },
  {
    slug: 'child-schedule',
    name: '子の予定',
    date: '2026年 6月15日',
    rows: [
      { label: '場所', fieldName: 'place', value: '市民プール（中央公園内）' },
      {
        label: '議事内容',
        fieldName: 'discussion',
        value:
          '・午前は自由遊泳、午後は短時間レッスンを予定。\n・天候によっては屋内プールへ振替の可能性あり。\n・終了後は近くのカフェで軽食を取って帰宅予定。',
      },
      { label: '持ち物', fieldName: 'items', value: '水着・タオル・帽子・水筒・着替え一式' },
      { label: '送迎担当', fieldName: 'escort', value: 'ママ（行き）／パパ（帰り）' },
      { label: '注意事項', fieldName: 'notes', value: '日焼け止め必須 ／ 食事は到着前に済ませる' },
    ],
  },
  {
    slug: 'budget-report',
    name: '家計報告',
    date: '2026年 5月度',
    rows: [
      { label: '月度', fieldName: 'month', value: '2026年 5月（5/1 〜 5/31）' },
      { label: '収入', fieldName: 'income', value: '￥520,000' },
      { label: '支出', fieldName: 'expense', value: '￥438,200' },
      { label: '貯蓄', fieldName: 'savings', value: '￥81,800' },
      {
        label: '議事内容',
        fieldName: 'discussion',
        value:
          '・前月比で食費が +1.2 万円。外食が増えたのが要因。\n・光熱費はエアコン使用増で +0.8 万円の見込み。\n・夏ボーナス前に積立額の見直しを行う方針で合意。',
      },
      { label: '次月予定', fieldName: 'next_plan', value: '旅行費の積立を増額 ／ 光熱費の見直し' },
    ],
  },
]

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * HTML 生成の二系統化。
 *
 * - `mode: 'thumb'` … サムネ用。<td> にダミー値を流し込む（既存挙動・カードプレビュー用）。
 * - `mode: 'background'` … AdjustView 背景用。
 *
 * 両モードの DOM 構造を**完全に同一**にし、background モードは
 *   値テキストを `<span class="bg-hide">…</span>` でラップして CSS `visibility: hidden`
 *   で見えなくする。表示は消えるが要素サイズは保持されるため、行の高さ・列幅は
 *   thumb モードと**構造的に一致**する。
 *
 * 経緯:
 *   従来 background モードは値セルを `&nbsp;` にしていたが、thumb と DOM が違うため
 *   CSS `table { flex:1 1 auto; height:100% }` の行高さ余剰均等配分が両モードで
 *   異なり、bbox 計測値（thumb DOM 由来）と bg.png 表示位置（background DOM 由来）に
 *   最大 +103pt の dy ズレが発生していた。値セル含めて DOM を一致させ、見た目だけ
 *   `visibility:hidden` で抑えることで配置ズレを根絶する。
 *
 * セル位置（getBoundingClientRect）は **両モードで構造的に同一**:
 *   - 値テキストノードを含む同一 DOM 構造（行の高さは中身の `<br>` 数で確定）。
 *   - visibility:hidden は要素サイズを保持するため、bg.png 上でもセル box は thumb と一致。
 *   - 罫線は table border により描画されるので visibility:hidden の影響を受けない。
 */
function renderHtml(spec: BuiltinSpec, mode: 'thumb' | 'background' = 'thumb'): string {
  const rowsHtml = spec.rows
    .map((r) => {
      // 値セルの中身は両モード共通の DOM 構造（実値テキスト + <br>）。
      // background モードでは <span.bg-hide> でラップして CSS で非表示にする。
      const valueInner = escapeHtml(r.value).replace(/\n/g, '<br />')
      const valueHtml =
        mode === 'background'
          ? `<span class="bg-hide">${valueInner}</span>`
          : valueInner
      return `
        <tr>
          <th>${escapeHtml(r.label)}</th>
          <td>${valueHtml}</td>
        </tr>`
    })
    .join('')

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    background: #ffffff;
    font-family: 'Hiragino Sans', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', sans-serif;
    color: #1F2937;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    width: 100%;
    height: 100%;
    padding: 52px 52px 40px;
    display: flex;
    flex-direction: column;
  }
  h1 {
    font-size: 32px;
    font-weight: 700;
    text-align: center;
    margin: 0 0 6px;
    letter-spacing: 0.08em;
    color: #1F2937;
  }
  .underline {
    height: 3px;
    background: #1F2937;
    width: 60%;
    margin: 6px auto 20px;
  }
  .date {
    text-align: right;
    font-size: 15px;
    margin-bottom: 18px;
    color: #374151;
  }
  table {
    width: 100%;
    height: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    flex: 1 1 auto;
  }
  th, td {
    border: 1.5px solid #1F2937;
    padding: 14px 14px;
    font-size: 15px;
    vertical-align: top;
    line-height: 1.6;
  }
  th {
    width: 28%;
    background: #F3F4F6;
    text-align: center;
    font-weight: 700;
    color: #111827;
  }
  td {
    background: #ffffff;
    color: #1F2937;
  }
  .footer {
    flex: 0 0 auto;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px dashed #9CA3AF;
    font-size: 12px;
    color: #6B7280;
    text-align: center;
    letter-spacing: 0.04em;
  }
  ${mode === 'background' ? '.bg-hide { visibility: hidden; }' : ''}
</style>
</head>
<body>
  <div class="page">
    <h1>${spec.name}</h1>
    <div class="underline"></div>
    <div class="date">${mode === 'background' ? `<span class="bg-hide">${escapeHtml(spec.date)}</span>` : escapeHtml(spec.date)}</div>
    <table>
      <tbody>${rowsHtml}
      </tbody>
    </table>
    <div class="footer">ぎじろっとくん サンプルテンプレ</div>
  </div>
</body>
</html>`
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const spec of SPECS) {
      const ctx = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 2, // Retina 相当・カード側 object-cover でくっきり
      })
      const page = await ctx.newPage()
      await page.setContent(renderHtml(spec, 'thumb'), { waitUntil: 'load' })
      // フォント読み込み完了を待つ（日本語フォントの遅延ロード対策）。
      await page.evaluate(() => document.fonts.ready)
      const buf = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        omitBackground: false,
      })
      const out = join(OUT_DIR, `${spec.slug}.png`)
      await writeFile(out, buf)
      console.log(`[ok] ${spec.slug} -> ${out} (${buf.length} bytes)`)

      // AdjustView 背景用 PNG を別途生成する。
      //   サムネ用 PNG はダミー値入りなので、AdjustView で背景に流用すると
      //   ユーザー入力値と二重表示される。背景用は値テキストを
      //   `<span class="bg-hide">` で包み visibility:hidden で見えなくする
      //   ＝罫線/ラベル/枠だけ残してユーザー値だけが乗る。
      //
      //   thumb と background の DOM 構造を完全一致させたので、
      //   <td> の box 寸法・行高さも構造的に一致する。bbox.json は thumb モード
      //   で計測したものをそのまま使って AdjustView 背景上に重ねて座標一致する
      //   （同一 DOM source of truth）。
      await page.setContent(renderHtml(spec, 'background'), { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      const bgBuf = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        omitBackground: false,
      })
      const bgOut = join(OUT_DIR, `${spec.slug}.bg.png`)
      await writeFile(bgOut, bgBuf)
      console.log(`[ok] ${spec.slug} (bg) -> ${bgOut} (${bgBuf.length} bytes)`)

      // bbox 計測は thumb モードに戻して実施（座標一致を担保）。
      await page.setContent(renderHtml(spec, 'thumb'), { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)

      // 各 row の <td>（value セル）の DOM 実測 bbox を取得し JSON 出力する。
      // - 座標系: getBoundingClientRect (px) = viewport 595x842 と一致。AdjustView は同じ pt 系。
      // - キーは spec.rows[].fieldName（templates.fields の name）。
      //   HTML 側 <tr> の挿入順と SPECS の rows 順は一致するので nth-child でひも付け可能。
      // - title / date は meta セクションに分離（参照用のみ）。
      // tsx が evaluate コールバックに `__name` ヘルパを挿入してしまう問題を避けるため、
      // Function コンストラクタで生 JS 関数を構築して page.evaluate に渡す（tsx の transform 対象外）。
      const fieldNamesArg = spec.rows.map((r) => r.fieldName)
      const evalFn = new Function(
        'fieldNames',
        `
        var pickRect = function(el) {
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        var titleRect = pickRect(document.querySelector('h1'));
        var dateRect = pickRect(document.querySelector('.date'));
        var trs = Array.from(document.querySelectorAll('tbody tr'));
        var fields = {};
        trs.forEach(function(tr, i) {
          var td = tr.querySelector('td');
          var name = fieldNames[i];
          if (!td || !name) return;
          var r = pickRect(td);
          if (r) fields[name] = r;
        });
        return { titleRect: titleRect, dateRect: dateRect, fields: fields };
      `,
      ) as (names: string[]) => unknown
      const rectsPayload = (await page.evaluate(evalFn, fieldNamesArg)) as {
        titleRect: { x: number; y: number; width: number; height: number } | null
        dateRect: { x: number; y: number; width: number; height: number } | null
        fields: Record<string, { x: number; y: number; width: number; height: number }>
      }

      const bboxJson = {
        slug: spec.slug,
        page: { width: WIDTH, height: HEIGHT },
        generated_at: new Date().toISOString(),
        meta: {
          title_rect: rectsPayload.titleRect,
          date_rect: rectsPayload.dateRect,
        },
        fields: rectsPayload.fields,
      }
      const jsonOut = join(OUT_DIR, `${spec.slug}.bbox.json`)
      await writeFile(jsonOut, JSON.stringify(bboxJson, null, 2) + '\n')
      console.log(
        `[ok] ${spec.slug}.bbox.json -> ${jsonOut} (fields=${Object.keys(rectsPayload.fields).length})`,
      )

      await ctx.close()
    }
  } finally {
    await browser.close()
  }
  console.log('done.')
}

main().catch((e) => {
  console.error('[build-builtin-template-thumbs] fatal:', e)
  process.exit(1)
})
