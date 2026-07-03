/**
 * スタイル学習系ヘルパー（fetch-style-summary / is-style-learning-enabled /
 * fetch-past-field-examples）が共通で使う、Supabase クライアントの最小インタフェース。
 * 実クライアントは route/action 側から渡される（このファイルはどちらが来ても動く形にする）。
 */
export interface StyleDb {
  from(table: string): {
    select: (columns: string) => {
      eq: (
        col: string,
        val: string | boolean,
      ) => {
        eq: (
          col: string,
          val: string | boolean,
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            limit: (
              n: number,
            ) => Promise<{ data: Array<Record<string, unknown>> | null; error: unknown }>
          }
        }
        maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>
      }
    }
  }
}

/**
 * Supabase 生成クライアントは PostgrestFilterBuilder（thenable だが Promise 型そのもの
 * ではない）を返すため、StyleDb の最小インタフェースとは型上一致しない。
 * build-style-profile.ts の StyleProfileDb と同じ理由で、実クライアントは実行時には
 * 構造的に適合するとみなし、この関数で境界を1箇所に集約してキャストする。
 */
export function asStyleDb(client: unknown): StyleDb {
  return client as StyleDb
}
