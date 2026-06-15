-- ============================================================================
-- minutes-app 初期シード
-- デフォルトテンプレ 3 種（家族会議 / 子の予定 / 家計報告）
-- 仕様書 §1-2 v1.4 ラインナップ確定版
-- ============================================================================

INSERT INTO public.templates
  (id, family_id, name, source_format, processed_path, fields, is_default, created_at)
VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    NULL,
    '家族会議',
    'builtin',
    'builtin/family_meeting_processed.docx',
    '[
      {"name":"meeting_date","label":"日付","type":"date","default":"today","required":true},
      {"name":"attendees","label":"参加者","type":"list","required":true},
      {"name":"agenda","label":"議題","type":"list","required":true},
      {"name":"discussion","label":"議事内容","type":"list","required":false},
      {"name":"decisions","label":"決定事項","type":"list","required":true},
      {"name":"todos","label":"TODO","type":"list","required":false}
    ]'::jsonb,
    true,
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    NULL,
    '子の予定',
    'builtin',
    'builtin/child_schedule_processed.docx',
    '[
      {"name":"event_date","label":"日付","type":"date","default":"today","required":true},
      {"name":"place","label":"場所","type":"text","required":true},
      {"name":"discussion","label":"議事内容","type":"list","required":false},
      {"name":"items","label":"持ち物","type":"list","required":false},
      {"name":"escort","label":"送迎担当","type":"text","required":false},
      {"name":"notes","label":"注意事項","type":"list","required":false}
    ]'::jsonb,
    true,
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    NULL,
    '家計報告',
    'builtin',
    'builtin/budget_report_processed.docx',
    '[
      {"name":"month","label":"月度","type":"text","required":true},
      {"name":"income","label":"収入","type":"text","required":true},
      {"name":"expense","label":"支出","type":"text","required":true},
      {"name":"savings","label":"貯蓄","type":"text","required":false},
      {"name":"discussion","label":"議事内容","type":"list","required":false},
      {"name":"next_plan","label":"次月予定","type":"list","required":false}
    ]'::jsonb,
    true,
    now()
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  fields = EXCLUDED.fields,
  processed_path = EXCLUDED.processed_path,
  thumbnail_path = EXCLUDED.thumbnail_path,
  is_default = EXCLUDED.is_default;
-- 以前は ON CONFLICT (id) DO NOTHING だったため、本番クラウド DB の
-- builtin 3 行がシード時点の旧 fields jsonb で固着し、後から discussion などを
-- seed.sql に追記しても反映されなかった。builtin は src/server/templates.ts の
-- CANNOT_EDIT_DEFAULT ガードでユーザー編集 UI が塞がれているため、is_default=true
-- + family_id=NULL の builtin に限り UPSERT で seed.sql を正本として上書き安全。

-- builtin の placeholder docx 本体は app/supabase/seed/templates/ 配下に置き、
-- scripts/seed-storage.ts で templates_processed/builtin/ に投入する（Phase 2 で実装）。
