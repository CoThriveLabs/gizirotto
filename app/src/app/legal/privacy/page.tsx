import type { Metadata } from 'next'
import { LegalLayout, LegalMetaCard } from '../_components/LegalLayout'

export const metadata: Metadata = {
  title: 'プライバシーポリシー — ぎじろっと',
  description: 'ぎじろっと（gizirotto）のプライバシーポリシーです。',
}

/**
 * プライバシーポリシーページ (v1.0.2)。
 * docs/drafts/privacy-policy-2026-06-15.md を TSX 化したもの。
 * 内容を変更した場合は src/lib/legal/versions.ts の PRIVACY_VERSION も更新すること。
 */
export default function PrivacyPage() {
  return (
    <LegalLayout>
      <h1>gizirotto プライバシーポリシー</h1>

      <LegalMetaCard
        service="gizirotto（ぎじろっと）"
        operator="Co-Thrive Labs（運営者: 倉西 斗夢）"
        contact="contact@cothrivelabs.com"
        enacted="2026-06-15"
        updated="2026-07-04"
        version="1.0.2"
      />

      <hr />

      <h2>1. はじめに</h2>
      <p>
        Co-Thrive Labs（以下「当方」）は、家庭用議事録アプリケーション「gizirotto」（以下「本サービス」）における個人情報の取扱いについて、本プライバシーポリシー（以下「本ポリシー」）を定めます。本サービスは、日本の <strong>個人情報保護法</strong> および EU 居住者向けには <strong>GDPR</strong>（EU 一般データ保護規則） を意識した取扱いを行います。
      </p>

      <h2>2. 本ポリシーへの同意</h2>
      <p>
        利用者は、本サービスへの <strong>初回ログイン時に表示される同意モーダル</strong> において、利用規約および本プライバシーポリシーに対する同意チェックを行うものとし、これをもって本ポリシーに同意したものとみなします。同意がない場合、本サービスの主要機能はご利用いただけません。
      </p>
      <p>本ポリシーの重要な変更があった場合、再度同意取得を行うことがあります。</p>

      <h2>3. 取得する個人情報</h2>
      <p>本サービスは、以下の情報を取得します。</p>

      <h3>3.1 アカウント登録情報</h3>
      <ul>
        <li>メールアドレス</li>
        <li>ユーザー名（任意のニックネーム）</li>
        <li>認証情報（パスワードはハッシュ化して保管）</li>
      </ul>

      <h3>3.2 家族メンバー情報（利用者が任意で登録）</h3>
      <ul>
        <li>家族メンバーの名前またはニックネーム</li>
        <li>役割（保護者・子ども等）</li>
        <li>議事録への登場頻度等の利用統計</li>
      </ul>

      <h3>3.3 ユーザーコンテンツ</h3>
      <ul>
        <li>議事録テキスト</li>
        <li>アップロードした PDF・画像・写真</li>
        <li>AI による要約・処理結果</li>
      </ul>

      <h3>3.4 学習データ（スタイルプロファイル）</h3>
      <ul>
        <li>過去の議事録から抽出した文体・語彙・書式の傾向</li>
        <li>家庭（世帯）単位で保存され、設定画面からいつでも削除できます</li>
      </ul>

      <h3>3.5 自動取得情報</h3>
      <ul>
        <li>アクセスログ（IP アドレス、User-Agent、アクセス日時）</li>
        <li>Cookie・セッション情報</li>
        <li>Cloudflare Turnstile によるボット判定用シグナル（TLS Fingerprint, IP 等）</li>
      </ul>

      <h2>4. 利用目的</h2>
      <p>取得した個人情報は、以下の目的で利用します。</p>
      <ol>
        <li>本サービスの提供・運営（アカウント認証、データ保存、議事録の生成等）</li>
        <li>AI 機能（OCR・整形・要約）の提供</li>
        <li>利用者の家庭ごとの書き方（文体・書式）の学習と下書きへの反映（外部 AI モデルの学習ではなく、各家庭内のデータのみを用いた自家庭内での活用です）</li>
        <li>重要なお知らせ・規約変更等の通知メール送信</li>
        <li>不正アクセス・スパム対策</li>
        <li>サービス品質改善のための利用状況分析（個人を特定しない形での統計化）</li>
        <li>お問い合わせへの対応</li>
        <li>法令に基づく対応</li>
      </ol>
      <p><strong>当方は、利用者の事前同意なく、これらの目的を超えて個人情報を利用しません。</strong></p>

      <h2>5. 第三者サービスへの提供（重要）</h2>
      <p>本サービスは、サービス提供のため以下の第三者サービスを利用しており、必要最小限の範囲でデータを送信・委託します。</p>

      <table>
        <thead>
          <tr>
            <th>サービス</th>
            <th>提供事業者</th>
            <th>用途</th>
            <th>主なデータ送信先（リージョン）</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Vercel</td><td>Vercel Inc.</td><td>ホスティング</td><td>米国</td></tr>
          <tr><td>Supabase</td><td>Supabase Inc.</td><td>DB・認証・ストレージ</td><td>米国（US East）</td></tr>
          <tr><td>Anthropic Claude API</td><td>Anthropic, PBC</td><td>議事録の整形・要約</td><td>米国</td></tr>
          <tr><td>Mistral OCR</td><td>Mistral AI SAS</td><td>画像 OCR</td><td>EU（フランス）／米国</td></tr>
          <tr><td>CloudConvert</td><td>Lunaweb Ltd.</td><td>PDF・画像変換</td><td>EU（ドイツ）</td></tr>
          <tr><td>Resend</td><td>Resend Inc.</td><td>メール送信</td><td>米国</td></tr>
          <tr><td>Cloudflare Turnstile</td><td>Cloudflare Inc.</td><td>ボット対策</td><td>グローバル（主に EU/米国）</td></tr>
        </tbody>
      </table>

      <h3>5.1 各サービスでのデータ取扱い（重要事項）</h3>
      <ul>
        <li><strong>Anthropic Claude API</strong>: 商用 API 規約のもと、当方が送信するデータはモデル学習に利用されません（2026 年 1 月時点）。データは不正利用検知のため最大 30 日間保持される場合があります。</li>
        <li><strong>Mistral OCR</strong>: 30 日間の悪用検出ウィンドウあり。当方が送信するデータはモデル学習に利用されません。</li>
        <li><strong>Supabase</strong>: 米国リージョンに保管されます。Supabase は GDPR DPA（データ処理契約）を提供しています。</li>
      </ul>

      <h3>5.2 第三者サービスの規約</h3>
      <p>各サービスのプライバシーポリシーは、それぞれの公式サイトをご確認ください。</p>

      <h2>6. 越境移転（海外データ転送）について</h2>
      <p>本サービスは、上記のとおり個人情報を <strong>米国・EU 諸国</strong> のサーバーに保管・送信します。日本国外への個人情報の移転にあたっては、以下の対応を行っています。</p>
      <ol>
        <li>
          <strong>米国への移転</strong>: 米国における個人情報保護制度に関する情報は、個人情報保護委員会の公表する{' '}
          <a
            href="https://www.ppc.go.jp/personalinfo/legal/kaiseihogohou/#gaikoku"
            target="_blank"
            rel="noopener noreferrer"
          >
            外国における個人情報の保護に関する制度等の調査
          </a>
          {' '}をご参照ください。
        </li>
        <li><strong>EU への移転</strong>: GDPR 準拠の事業者（Mistral, CloudConvert 等）を選定しています。</li>
        <li><strong>GDPR 域内利用者</strong>: EU/EEA からのアクセスについては、Standard Contractual Clauses (SCC) を用いる事業者を利用しています。</li>
      </ol>
      <p>本サービスの初回ログイン時の同意取得をもって、利用者は上記の越境移転に <strong>同意</strong> したものとみなします。</p>

      <h2>7. Cookie・トラッキング技術の使用</h2>
      <p>本サービスは、以下の用途で Cookie 等の技術を使用します。</p>
      <ol>
        <li><strong>認証セッション維持</strong>: Supabase Auth により、ログイン状態を維持するための Cookie を利用します。</li>
        <li><strong>CSRF 対策</strong>: Next.js のセキュリティトークン用 Cookie を利用します。</li>
        <li><strong>ボット対策</strong>: Cloudflare Turnstile が一時的な Cookie/シグナルを取得します。</li>
      </ol>
      <p>本サービスは、 <strong>広告目的のトラッキング Cookie・第三者アナリティクス（Google Analytics 等）は使用していません</strong>。将来導入する場合は本ポリシーを更新し、必要に応じて再同意を取得します。</p>

      <h2>8. 保管期間</h2>
      <table>
        <thead>
          <tr><th>データ種別</th><th>保管期間</th></tr>
        </thead>
        <tbody>
          <tr><td>アカウント情報</td><td>アカウント有効期間中＋設定画面からのセルフ削除で速やかに削除、または削除請求受付後 30 日以内に削除</td></tr>
          <tr><td>ユーザーコンテンツ（議事録等）</td><td>アカウント有効期間中＋設定画面からのセルフ削除で速やかに削除、または削除請求受付後 30 日以内に削除。ただし、世帯に他のメンバーがいる場合は、世帯で共有しているユーザーコンテンツ・学習データは削除者の退会後も他メンバーの利用のため保持されます（詳細は §9.3 参照）</td></tr>
          <tr><td>アクセスログ</td><td>90 日間</td></tr>
          <tr><td>メール送信ログ（Resend）</td><td>Resend のポリシーに準拠</td></tr>
          <tr><td>AI 処理データ（Anthropic 等）</td><td>各サービスのポリシーに準拠（最大 30 日）</td></tr>
        </tbody>
      </table>

      <h2>9. 利用者の権利</h2>
      <p>利用者は、自身の個人情報について以下の権利を有します。</p>

      <h3>9.1 日本の個人情報保護法に基づく権利</h3>
      <ul>
        <li>開示請求</li>
        <li>訂正・追加・削除請求</li>
        <li>利用停止請求</li>
        <li>第三者提供停止請求</li>
      </ul>

      <h3>9.2 GDPR（EU 居住者）に基づく権利</h3>
      <ul>
        <li>アクセス権（Right of Access）</li>
        <li>訂正権（Right to Rectification）</li>
        <li>削除権・忘れられる権利（Right to Erasure）</li>
        <li>処理制限権（Right to Restriction）</li>
        <li>データポータビリティ権（Right to Data Portability）</li>
        <li>異議申立権（Right to Object）</li>
        <li>同意撤回権（Right to Withdraw Consent）</li>
      </ul>

      <h3>9.3 行使方法</h3>
      <ul>
        <li>
          <strong>アカウント削除機能</strong>: 利用者は、設定画面からご自身でアカウントを削除できます。削除時に実際に消去・保持されるデータの範囲は、利用者が所属する家庭（世帯）の構成により異なります。
          <ul>
            <li>
              <strong>利用者が世帯唯一のメンバーである場合</strong>:
              議事録・テンプレート・学習データ（スタイルプロファイル）を含む世帯の全データ、および関連するストレージ上のファイルが完全に削除されます。この操作は取り消せません。
            </li>
            <li>
              <strong>他にメンバーがいて、利用者が世帯唯一の管理者である場合</strong>:
              アカウント削除は一旦ブロックされます。先に他のメンバーを管理者に指定したうえで、再度削除を行ってください。
            </li>
            <li>
              <strong>他にメンバーがいて、利用者が世帯唯一の管理者ではない場合</strong>:
              利用者自身のアカウントとチャット履歴のみが削除されます。世帯で共有している議事録・テンプレート・学習データは、他のメンバーが引き続き利用するため保持され、利用者が作成したコンテンツの作成者表記は「（退会済みユーザー）」に変わります。
            </li>
          </ul>
        </li>
        <li>設定画面からの操作が難しい場合は、下記窓口までご連絡いただければ、当方にて対応いたします（データ削除権・忘れられる権利を含む全ての請求が対象）。</li>
        <li>
          各種請求の窓口:{' '}
          <strong>
            <a href="mailto:contact@cothrivelabs.com">contact@cothrivelabs.com</a>
          </strong>
        </li>
      </ul>

      <h2>10. セキュリティ対策</h2>
      <p>当方は、個人情報の漏えい・滅失・毀損を防止するため、以下の対策を講じています。</p>
      <ol>
        <li>パスワードのハッシュ化保管（bcrypt 等）</li>
        <li>HTTPS による通信暗号化（Vercel 標準）</li>
        <li>Supabase Row Level Security (RLS) によるデータアクセス制御</li>
        <li>アクセスログの監視</li>
        <li>必要最小限の権限による運用（最小権限の原則）</li>
      </ol>
      <p>ただし、本サービスは <strong>無償の個人開発プロジェクト</strong> であり、完全なセキュリティを保証するものではありません。利用者は重要なデータについて自己責任でバックアップを取得してください。</p>

      <h2>11. 子どもの個人情報</h2>
      <p>本サービスでは、利用者が <strong>家族メンバーとして子どもの情報</strong> を任意に登録することがあります。13 歳未満の子どもの情報を登録する場合、必ず保護者の同意のもと登録してください。当方は、子どもから直接個人情報を取得することは想定していません。</p>

      <h2>12. 個人情報の漏えい時の対応</h2>
      <p>万が一、個人情報の漏えい等の事案が発生した場合、当方は以下の対応を行います。</p>
      <ol>
        <li>速やかに事実関係を調査し、影響を最小化する措置を講じます。</li>
        <li>個人情報保護委員会への報告が必要な事案については、法令に基づき報告します。</li>
        <li>影響を受ける利用者に対し、メール等で速やかに通知します。</li>
      </ol>

      <h2>13. プライバシーポリシーの変更</h2>
      <ol>
        <li>本ポリシーは、法令の変更・サービス内容の変更等に応じて改定することがあります。</li>
        <li>重要な変更を行う場合、本サービス内の通知またはメールで <strong>施行日の 14 日前</strong> までに通知し、必要に応じて再同意を取得します。</li>
        <li>軽微な変更（誤字修正等）は事前通知なく行うことがあります。</li>
      </ol>

      <h2>14. お問い合わせ窓口</h2>
      <p>個人情報の取扱いに関するお問い合わせ・各種請求は、以下の窓口までお願いします。</p>
      <ul>
        <li><strong>運営者</strong>: Co-Thrive Labs（運営者: 倉西 斗夢）</li>
        <li>
          <strong>メール</strong>:{' '}
          <a href="mailto:contact@cothrivelabs.com">contact@cothrivelabs.com</a>
        </li>
        <li><strong>対応言語</strong>: 日本語</li>
      </ul>

      <hr />

      <p>
        <strong>附則</strong>
      </p>
      <ul>
        <li>制定日: 2026-06-15</li>
        <li>最終更新: 2026-07-04</li>
        <li>バージョン: 1.0.2</li>
        <li>1.0 → 1.0.1: アカウント削除機能未実装に伴う暫定運用（§9.3 / §8 保管期間）を contact@ 経由の手動対応として明記</li>
        <li>1.0.1 → 1.0.2: 利用者自身によるアカウント削除機能の実装、および家庭ごとの書き方の学習機能に伴う取得情報・利用目的の追記</li>
      </ul>
    </LegalLayout>
  )
}
