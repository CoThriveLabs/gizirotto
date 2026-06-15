drop extension if exists "pg_net";

set check_function_bodies = off;

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
  INSERT INTO public.family_members (family_id, user_id, display_name, role)
    VALUES (v_family.id, v_uid, p_display_name, 'member');

  RETURN v_family;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  claims jsonb;
  v_family_id uuid;
BEGIN
  claims := event -> 'claims';
  SELECT fm.family_id
  INTO v_family_id
  FROM public.family_members fm
  WHERE fm.user_id = (event ->> 'user_id')::uuid
  ORDER BY fm.created_at ASC
  LIMIT 1;

  IF v_family_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{family_id}', to_jsonb(v_family_id::text));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.join_family_by_invite_code(p_code text, p_display_name text)
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

  -- 形式チェック（アプリ層と二重防御）
  IF p_code IS NULL OR length(p_code) <> 10
     OR p_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' THEN
    RAISE EXCEPTION 'INVALID_CODE' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_display_name, '')) < 1 OR length(p_display_name) > 20 THEN
    RAISE EXCEPTION 'INVALID_DISPLAY_NAME' USING ERRCODE = '22023';
  END IF;

  -- 二重所属チェック（先にやる: 既参加ユーザーが別招待コードを試す UX を考えると親切）
  IF EXISTS (SELECT 1 FROM public.family_members WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = '23505';
  END IF;

  -- 招待コード lookup（SECURITY DEFINER で RLS バイパス）
  SELECT * INTO v_family FROM public.families WHERE invite_code = p_code LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_CODE' USING ERRCODE = '22023';
  END IF;

  -- 期限チェック
  IF v_family.invite_code_expires_at < now() THEN
    RAISE EXCEPTION 'CODE_EXPIRED' USING ERRCODE = '22023';
  END IF;

  -- family_members INSERT
  INSERT INTO public.family_members (family_id, user_id, display_name, role)
    VALUES (v_family.id, v_uid, p_display_name, 'member');

  RETURN v_family;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.match_documents(query_embedding public.vector, match_threshold double precision DEFAULT 0.75, match_count integer DEFAULT 5, p_family_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(minutes_id uuid, family_id uuid, meeting_date date, content_json jsonb, similarity double precision)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    m.id AS minutes_id,
    m.family_id,
    m.meeting_date,
    m.content_json,
    1 - (me.embedding <=> query_embedding) AS similarity
  FROM public.minutes_embeddings me
  JOIN public.minutes m ON m.id = me.minutes_id
  WHERE
    (p_family_id IS NULL OR me.family_id = p_family_id)
    AND m.exclude_from_learning = false
    AND 1 - (me.embedding <=> query_embedding) > match_threshold
  ORDER BY me.embedding <=> query_embedding ASC
  LIMIT match_count;
END;
$function$
;


