-- Phase 5a: create_family_with_owner RPC の家族作成者 role を 'admin' に修正
--
-- 経緯: baseline migration (20260526112403_remote_schema.sql) の create_family_with_owner では
-- 家族作成者を role='member' で INSERT していたが、内部仕様では
-- 「家族作成者は admin（管理者）として登録」が前提。
-- /members の招待コード表示 + テンプレ再生成ボタンが admin only のため、
-- 'member' だとこれら UI が機能しない（Phase 5a 検証で発覚 2026-05-26）。
-- 本 migration で 'admin' に修正。
--
-- 差分: 関数本体 47 行目の VALUES (v_family.id, v_uid, p_display_name, 'member')
--      → VALUES (v_family.id, v_uid, p_display_name, 'admin')
-- それ以外は baseline と完全同一。

CREATE OR REPLACE FUNCTION public.create_family_with_owner(p_family_name text, p_display_name text, p_invite_code text, p_invite_code_expires_at timestamp with time zone)
 RETURNS public.families
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_family public.families;
BEGIN
  -- 認証チェック
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  -- 入力バリデーション（アプリ層 zod と二重防御）
  IF length(coalesce(p_family_name, '')) < 1 OR length(p_family_name) > 40 THEN
    RAISE EXCEPTION 'INVALID_FAMILY_NAME' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_display_name, '')) < 1 OR length(p_display_name) > 20 THEN
    RAISE EXCEPTION 'INVALID_DISPLAY_NAME' USING ERRCODE = '22023';
  END IF;
  IF p_invite_code IS NULL OR length(p_invite_code) <> 10
     OR p_invite_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' THEN
    RAISE EXCEPTION 'INVALID_CODE' USING ERRCODE = '22023';
  END IF;
  IF p_invite_code_expires_at IS NULL OR p_invite_code_expires_at <= now() THEN
    RAISE EXCEPTION 'INVALID_EXPIRES_AT' USING ERRCODE = '22023';
  END IF;

  -- 二重所属チェック
  IF EXISTS (SELECT 1 FROM public.family_members WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = '23505';
  END IF;

  -- families INSERT
  INSERT INTO public.families (name, invite_code, invite_code_expires_at)
    VALUES (p_family_name, p_invite_code, p_invite_code_expires_at)
    RETURNING * INTO v_family;

  -- family_members INSERT（SECURITY DEFINER で RLS バイパス、UNIQUE INDEX は通る）
  -- 家族作成者は admin として登録
  INSERT INTO public.family_members (family_id, user_id, display_name, role)
    VALUES (v_family.id, v_uid, p_display_name, 'admin');

  RETURN v_family;
END;
$function$
;
