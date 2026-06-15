-- ============================================================================
-- 修復: 以前にシードされた builtin templates の fields jsonb に
-- discussion (議事内容) フィールドを追記する。
--
-- 真因: supabase/seed.sql の INSERT が ON CONFLICT (id) DO NOTHING で
-- 上書きできないため、本番クラウド DB の builtin 3 行が旧 5 件版
-- （discussion 抜き）で固着している。
-- AdjustView (src/app/(dashboard)/minutes/[id]/adjust/page.tsx) の
-- extractFieldDefs は DB の template.fields を反復源とするため、DB に
-- discussion entry が無いと bbox JSON にあっても永遠に描画されない。
--
-- 本 migration は対象 3 行に限定し、jsonb 配列末尾に discussion entry を
-- 1 件追記する（既に discussion を含む場合は noop = 冪等）。fields の
-- 反復順序はテンプレ固有の固定テキスト座標ではなく描画ロジックの
-- bbox 座標で決まるため、末尾追記による UI 影響はない。
-- ============================================================================

UPDATE public.templates
SET fields = fields || '[{"name":"discussion","label":"議事内容","type":"list","required":false}]'::jsonb
WHERE id IN (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003'
)
AND family_id IS NULL
AND is_default = true
AND NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(fields) e WHERE e->>'name' = 'discussion'
);
