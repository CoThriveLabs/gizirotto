


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;








CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";






CREATE OR REPLACE FUNCTION "public"."ai_usage_exceeded"("p_family_id" "uuid", "p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_family_daily      int;
  v_family_cap_daily  int;
  v_user_hourly       int;
  v_user_cap_hourly   int;
  v_global_cost_today numeric;
  -- global cap は呼出回数ではなく AI API コストベースで判定する
  -- 月 $20 / 30 日 ≒ $0.667/日 → 安全側 $0.50/日 (Console spend limit との二重防御)
  v_global_cost_cap_per_day constant numeric := 0.50;
begin
  -- 家族上限を取得
  select ai_calls_per_day, ai_calls_per_hour_user
    into v_family_cap_daily, v_user_cap_hourly
    from public.family_limits
    where family_id = p_family_id;

  -- limits 未設定: 上限不明として exceeded=true (保守的に止める)
  if v_family_cap_daily is null then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'unknown',
      'reason', 'no_family_limits'
    );
  end if;

  -- 家族 1 日上限 check
  select count(*) into v_family_daily
    from public.ai_usage_log
    where family_id = p_family_id
      and created_at > now() - interval '1 day';
  if v_family_daily >= v_family_cap_daily then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'family',
      'used', v_family_daily,
      'cap',  v_family_cap_daily,
      'reset_at', date_trunc('day', now()) + interval '1 day'
    );
  end if;

  -- ユーザー 1 時間上限 check
  select count(*) into v_user_hourly
    from public.ai_usage_log
    where user_id = p_user_id
      and created_at > now() - interval '1 hour';
  if v_user_hourly >= v_user_cap_hourly then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'user',
      'used', v_user_hourly,
      'cap',  v_user_cap_hourly,
      'reset_at', date_trunc('hour', now()) + interval '1 hour'
    );
  end if;

  -- 全体 1 日上限 check (cost ベース)
  select coalesce(sum(cost_usd_estimate), 0) into v_global_cost_today
    from public.ai_usage_log
    where created_at > date_trunc('day', now());
  if v_global_cost_today >= v_global_cost_cap_per_day then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'global',
      'used_cost', v_global_cost_today,
      'cap_cost',  v_global_cost_cap_per_day,
      'reset_at', date_trunc('day', now()) + interval '1 day'
    );
  end if;

  return jsonb_build_object('exceeded', false);
end;
$_$;


ALTER FUNCTION "public"."ai_usage_exceeded"("p_family_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_minutes_monthly_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_used int;
  v_cap  int;
begin
  -- limits 未設定なら通す (保守的・既存ユーザー保護)
  select max_minutes_monthly into v_cap
    from public.family_limits where family_id = new.family_id;
  if v_cap is null then
    return new;
  end if;

  -- 当月の議事録件数を集計 (created_at が今月のもののみ)
  select count(*) into v_used from public.minutes
    where family_id = new.family_id
      and created_at >= date_trunc('month', now());

  if v_used >= v_cap then
    raise exception '議事録の今月上限（%）に達しました', v_cap
      using errcode = 'P0001',
            hint    = 'family_resource_limit';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."check_minutes_monthly_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_templates_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_used int;
  v_cap  int;
begin
  -- builtin (family_id is null) は上限対象外
  if new.family_id is null then
    return new;
  end if;

  select max_templates into v_cap
    from public.family_limits where family_id = new.family_id;
  if v_cap is null then
    return new;
  end if;

  select count(*) into v_used from public.templates
    where family_id = new.family_id;

  if v_used >= v_cap then
    raise exception 'テンプレ累積上限（%）に達しました', v_cap
      using errcode = 'P0001',
            hint    = 'family_resource_limit';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."check_templates_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_family_limits_on_family_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.family_limits (family_id) values (new.id)
    on conflict (family_id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."create_family_limits_on_family_insert"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."families" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "invite_code" "text" NOT NULL,
    "invite_code_expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "style_learning_enabled" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."families" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_family_with_owner"("p_family_name" "text", "p_display_name" "text", "p_invite_code" "text", "p_invite_code_expires_at" timestamp with time zone) RETURNS "public"."families"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
  -- 家族作成者は admin ロールとして登録する
  INSERT INTO public.family_members (family_id, user_id, display_name, role)
    VALUES (v_family.id, v_uid, p_display_name, 'admin');

  RETURN v_family;
END;
$_$;


ALTER FUNCTION "public"."create_family_with_owner"("p_family_name" "text", "p_display_name" "text", "p_invite_code" "text", "p_invite_code_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."custom_access_token_hook"("event" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_minute_with_files"("p_minute_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_family_id uuid;
  v_user_family_id uuid;
  v_output_pdf_path text;
  v_output_docx_path text;
  v_thumbnail_path text;
BEGIN
  -- 認可: minute の family_id と current user の family_id 一致確認
  SELECT family_id, output_pdf_path, output_docx_path, thumbnail_path
    INTO v_family_id, v_output_pdf_path, v_output_docx_path, v_thumbnail_path
    FROM public.minutes WHERE id = p_minute_id;
  SELECT family_id INTO v_user_family_id FROM public.family_members WHERE user_id = auth.uid();
  IF v_family_id IS NULL OR v_family_id <> v_user_family_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- DB 行削除（messages → chat_sessions → minutes の FK 解消順）
  -- 議事録削除は物理削除即時（論理削除・ゴミ箱機能は未実装）。
  -- chat_sessions.minute_id は SET NULL 定義だが、孤児レコードを残さないため明示的に削除する。
  -- 将来ゴミ箱機能を導入する場合は schema 自体を論理削除方式に書き換える想定（minutes / chat_sessions 双方に deleted_at 追加）。
  DELETE FROM public.messages
    WHERE session_id IN (
      SELECT id FROM public.chat_sessions WHERE minute_id = p_minute_id
    );
  DELETE FROM public.chat_sessions WHERE minute_id = p_minute_id;
  DELETE FROM public.minutes WHERE id = p_minute_id;

  -- storage オブジェクト削除（失敗しても WARN ログのみ、DB 行は確実に消す優先）
  BEGIN
    IF v_output_pdf_path IS NOT NULL THEN
      DELETE FROM storage.objects WHERE bucket_id = 'minutes_output' AND name = v_output_pdf_path;
    END IF;
    IF v_output_docx_path IS NOT NULL THEN
      DELETE FROM storage.objects WHERE bucket_id = 'minutes_output' AND name = v_output_docx_path;
    END IF;
    IF v_thumbnail_path IS NOT NULL THEN
      DELETE FROM storage.objects WHERE bucket_id = 'image_cache' AND name = v_thumbnail_path;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'delete_minute_with_files: storage cleanup partial failure for minute_id=%, error=%', p_minute_id, SQLERRM;
  END;
END;
$$;


ALTER FUNCTION "public"."delete_minute_with_files"("p_minute_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."delete_minute_with_files"("p_minute_id" "uuid") IS '議事録物理削除 + 関連 storage オブジェクト一括削除。将来的に論理削除 + 30 日ゴミ箱復元への書き換えを想定。';



CREATE OR REPLACE FUNCTION "public"."join_family_by_invite_code"("p_code" "text", "p_display_name" "text") RETURNS "public"."families"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "public"."join_family_by_invite_code"("p_code" "text", "p_display_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision DEFAULT 0.75, "match_count" integer DEFAULT 5, "p_family_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("minutes_id" "uuid", "family_id" "uuid", "meeting_date" "date", "content_json" "jsonb", "similarity" double precision)
    LANGUAGE "plpgsql" STABLE
    AS $$
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
$$;


ALTER FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "p_family_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."regenerate_family_invite_code"("p_family_id" "uuid", "p_new_code" "text") RETURNS TABLE("invite_code" "text", "invite_code_expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  v_user_family_id uuid;
  v_user_role text;
  v_new_expires_at timestamptz;
BEGIN
  -- 認可: 呼出ユーザーが対象 family の admin であること確認
  SELECT family_id, role INTO v_user_family_id, v_user_role
    FROM public.family_members WHERE user_id = auth.uid();
  IF v_user_family_id IS NULL OR v_user_family_id <> p_family_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF v_user_role <> 'admin' THEN
    RAISE EXCEPTION 'ADMIN_ONLY';
  END IF;

  -- 新コード形式 check（既存 families.invite_code の baseline CHECK と同等、紛らわしい文字除外 32 文字 10 桁）
  IF p_new_code IS NULL OR length(p_new_code) <> 10
     OR p_new_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' THEN
    RAISE EXCEPTION 'INVALID_CODE_FORMAT';
  END IF;

  -- TTL 7 日リセット
  v_new_expires_at := now() + interval '7 days';

  -- UPDATE families.invite_code + invite_code_expires_at（UNIQUE 制約自動 verify）
  BEGIN
    UPDATE public.families
      SET invite_code = p_new_code,
          invite_code_expires_at = v_new_expires_at
      WHERE id = p_family_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- 衝突発生時はアプリ側で再生成リトライ（nanoid 衝突確率 1/3.4×10^16）
      RAISE EXCEPTION 'CODE_COLLISION';
  END;

  -- 戻り値: 新コード + 期限
  RETURN QUERY SELECT p_new_code, v_new_expires_at;
END;
$_$;


ALTER FUNCTION "public"."regenerate_family_invite_code"("p_family_id" "uuid", "p_new_code" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."regenerate_family_invite_code"("p_family_id" "uuid", "p_new_code" "text") IS '招待コード再発行（admin only）。CODE_COLLISION 時はアプリ側で 1 回リトライする。';



CREATE OR REPLACE FUNCTION "public"."reset_request_exists_today_jst"("p_family_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists(
    select 1 from public.reset_requests
     where family_id = p_family_id
       and created_at >= date_trunc('day', now() at time zone 'Asia/Tokyo')
                          at time zone 'Asia/Tokyo'
  );
$$;


ALTER FUNCTION "public"."reset_request_exists_today_jst"("p_family_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."abuse_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "pattern" "text" NOT NULL,
    "detail" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."abuse_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_usage_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid",
    "user_id" "uuid",
    "endpoint" "text" NOT NULL,
    "input_tokens" integer DEFAULT 0,
    "output_tokens" integer DEFAULT 0,
    "cost_usd_estimate" numeric(10,6) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ai_usage_log_endpoint_check" CHECK (("endpoint" = ANY (ARRAY['format-item'::"text", 'chat-stream'::"text", 'whiteout-preview'::"text", 'whiteout-apply'::"text", 'style-profile'::"text"])))
);


ALTER TABLE "public"."ai_usage_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "template_id" "uuid",
    "mode" "text" NOT NULL,
    "minute_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "chat_sessions_mode_check" CHECK (("mode" = ANY (ARRAY['A-1'::"text", 'A-2'::"text"])))
);


ALTER TABLE "public"."chat_sessions" OWNER TO "postgres";


COMMENT ON TABLE "public"."chat_sessions" IS 'AI チャットセッション (A-1 質問順 / A-2 自由会話)。B-2 項目モードは chat 不要のため記録しない。minute_id は議事録保存後にリンク、それ以前は NULL。';



COMMENT ON COLUMN "public"."chat_sessions"."template_id" IS 'チャットセッション開始時のテンプレ。テンプレ削除（SET NULL）後も履歴を残せるよう NULL 許容。';



COMMENT ON COLUMN "public"."chat_sessions"."created_by" IS 'セッション所有者。退会時の SET NULL を許容するため NULL 可。';



CREATE TABLE IF NOT EXISTS "public"."family_limits" (
    "family_id" "uuid" NOT NULL,
    "ai_calls_per_day" integer DEFAULT 30 NOT NULL,
    "ai_calls_per_hour_user" integer DEFAULT 10 NOT NULL,
    "max_minutes_monthly" integer DEFAULT 100 NOT NULL,
    "max_templates" integer DEFAULT 50 NOT NULL,
    "max_storage_bytes" bigint DEFAULT 524288000 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."family_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."family_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "onboarding_step" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."family_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"])))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."minutes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "template_id" "uuid",
    "title" "text" NOT NULL,
    "meeting_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "content_json" "jsonb" NOT NULL,
    "source_mode" "text",
    "is_imported" boolean DEFAULT false NOT NULL,
    "exclude_from_learning" boolean DEFAULT false NOT NULL,
    "tone_preference" "jsonb",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "output_pdf_path" "text",
    "thumbnail_path" "text",
    "thumbnail_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "bbox_overrides" "jsonb",
    "output_docx_path" "text",
    "new_fields" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "minutes_source_mode_check" CHECK (("source_mode" = ANY (ARRAY['A-1'::"text", 'A-2'::"text", 'B-2'::"text", 'imported'::"text"]))),
    CONSTRAINT "minutes_thumbnail_status_check" CHECK (("thumbnail_status" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."minutes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."minutes"."template_id" IS '議事録作成時のテンプレ。テンプレ削除（SET NULL）後も議事録本体は残るよう NULL 許容。';



COMMENT ON COLUMN "public"."minutes"."created_by" IS '議事録作成者。退会時に auth.users 削除で SET NULL（家族で引き続き閲覧可）。';



COMMENT ON COLUMN "public"."minutes"."output_pdf_path" IS '議事録 PDF 出力結果の Storage パス（minutes_output バケット内）。 未生成のときは NULL、生成済なら例: "{family_id}/{minutes_id}.pdf"。';



COMMENT ON COLUMN "public"."minutes"."thumbnail_path" IS 'image_cache バケット内パス: {family_id}/minutes/{minutes_id}_72_png.png';



COMMENT ON COLUMN "public"."minutes"."thumbnail_status" IS 'pending = 生成中 / ready = 完了 / failed = 失敗（minutes に skipped はない、templates 専用状態）';



COMMENT ON COLUMN "public"."minutes"."bbox_overrides" IS '微調整 UI で議事録ごとに上書きされた bbox の差分。NULL = テンプレ fields.json の bbox をそのまま使う。形式: { field_name: { x, y } } の Partial（現状は x/y のみ、リサイズ対応は未実装）';



COMMENT ON COLUMN "public"."minutes"."output_docx_path" IS 'minutes_output バケットの docx 出力 path: {family_id}/{minutes_id}.docx。content / bbox_overrides 変更時は NULL リセットして次回 docx ダウンロードで再生成。';



COMMENT ON COLUMN "public"."minutes"."new_fields" IS 'PdfField[]（{name,label,bbox:{page,x,y,w,h},type,font,...}・左上原点 pt）。
   AdjustView で追加した記入欄のみ。テンプレ fields とは独立。null は無く必ず配列（DEFAULT [])。
   merge は mergeTemplateAndNewFields(templates 優先・newFields 同 name は採番再確定) で実施。';



CREATE TABLE IF NOT EXISTS "public"."minutes_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "minutes_id" "uuid" NOT NULL,
    "family_id" "uuid" NOT NULL,
    "embedding" "public"."vector"(1536) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."minutes_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reset_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "requested_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reset_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signup_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ip" "text",
    "email_domain" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."signup_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid",
    "name" "text" NOT NULL,
    "source_format" "text" NOT NULL,
    "source_path" "text",
    "processed_path" "text" NOT NULL,
    "fields" "jsonb" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "background_pdf_path" "text",
    "input_path_type" "text",
    "license_consent" "jsonb",
    "user_style_id" "uuid",
    "thumbnail_path" "text",
    "thumbnail_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "blank_pdf_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "whiteout_boxes" "jsonb",
    "fixed_texts" "jsonb",
    "origin_format" "text",
    CONSTRAINT "chk_pdf_license_consent" CHECK ((("source_format" <> 'pdf'::"text") OR ("is_default" = true) OR ("license_consent" IS NOT NULL))),
    CONSTRAINT "templates_blank_pdf_status_check" CHECK (("blank_pdf_status" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'failed'::"text"]))),
    CONSTRAINT "templates_input_path_type_check" CHECK ((("input_path_type" IS NULL) OR ("input_path_type" = ANY (ARRAY['A'::"text", 'B'::"text"])))),
    CONSTRAINT "templates_source_format_check" CHECK (("source_format" = ANY (ARRAY['docx'::"text", 'pdf'::"text", 'builtin'::"text"]))),
    CONSTRAINT "templates_thumbnail_status_check" CHECK (("thumbnail_status" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."templates" OWNER TO "postgres";


COMMENT ON COLUMN "public"."templates"."created_by" IS 'テンプレ作成者。退会時に auth.users 削除で SET NULL（家族で引き続き使用可）。';



COMMENT ON COLUMN "public"."templates"."background_pdf_path" IS 'パス A: 未書込原本 / パス B: 自動白塗り済の PDF Storage パス。';



COMMENT ON COLUMN "public"."templates"."input_path_type" IS 'A: 未書込原本（メイン主軸）/ B: 書込済→白塗り化（フォールバック）。';



COMMENT ON COLUMN "public"."templates"."license_consent" IS 'ユーザー同意チェック日時。著作権予防策として同意記録を保持する。';



COMMENT ON COLUMN "public"."templates"."user_style_id" IS '個人スタイル参照。未実装機能のため現状は NULL';



COMMENT ON COLUMN "public"."templates"."thumbnail_path" IS 'image_cache バケット内パス: {family_id}/templates/{template_id}_72_png.png';



COMMENT ON COLUMN "public"."templates"."thumbnail_status" IS 'pending = 生成中 / ready = 完了 / failed = 失敗 / skipped = docx 出力でサムネ画像生成を省略する場合（外部 SaaS 導入後に pending→ready 遷移へ対応予定）';



COMMENT ON COLUMN "public"."templates"."blank_pdf_status" IS 'docx テンプレ blank PDF 化ステータス。pdf テンプレは既存パイプで blank PDF 生成済のため常に ready 扱い。pending = 生成中 / ready = 完了 / failed = CloudConvert 呼出失敗（再アップロード待ち）';



COMMENT ON COLUMN "public"."templates"."whiteout_boxes" IS 'パスB白塗り座標の永続化。WhiteoutBox[]・左上原点 pt。null=白塗り未適用 or 旧データ（従来 _blank.pdf にフォールバック）';



COMMENT ON COLUMN "public"."templates"."fixed_texts" IS 'C-2（固定テキスト・あめ要望の新機能）。FixedText[]（{name,value,bbox:{page,x,y,w,h},font}・左上原点 pt）。
   用途: 会議名・参加者など常時同一値を overlay 出力へ常時注入。記入欄 fields とは分離（fieldsVersion を汚さない）。
   ※白塗り whiteout_boxes / 既存 whiteout_C2 設計とは無関係。null = 固定テキスト未設定';



CREATE TABLE IF NOT EXISTS "public"."user_consents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "terms_version" "text" NOT NULL,
    "privacy_version" "text" NOT NULL,
    "consented_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "text"
);


ALTER TABLE "public"."user_consents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_styles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "profile" "jsonb" NOT NULL,
    "source_minutes_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "last_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_styles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."abuse_alerts"
    ADD CONSTRAINT "abuse_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_sessions"
    ADD CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_invite_code_key" UNIQUE ("invite_code");



ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."family_limits"
    ADD CONSTRAINT "family_limits_pkey" PRIMARY KEY ("family_id");



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_family_id_user_id_key" UNIQUE ("family_id", "user_id");



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."minutes_embeddings"
    ADD CONSTRAINT "minutes_embeddings_minutes_id_key" UNIQUE ("minutes_id");



ALTER TABLE ONLY "public"."minutes_embeddings"
    ADD CONSTRAINT "minutes_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."minutes"
    ADD CONSTRAINT "minutes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reset_requests"
    ADD CONSTRAINT "reset_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."signup_attempts"
    ADD CONSTRAINT "signup_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_consents"
    ADD CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_styles"
    ADD CONSTRAINT "user_styles_pkey" PRIMARY KEY ("id");



CREATE INDEX "ai_usage_log_family_created_idx" ON "public"."ai_usage_log" USING "btree" ("family_id", "created_at" DESC);



CREATE INDEX "ai_usage_log_global_created_idx" ON "public"."ai_usage_log" USING "btree" ("created_at" DESC);



CREATE INDEX "ai_usage_log_user_created_idx" ON "public"."ai_usage_log" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_chat_sessions_family_created_at" ON "public"."chat_sessions" USING "btree" ("family_id", "created_at" DESC);



CREATE INDEX "idx_family_members_family_id" ON "public"."family_members" USING "btree" ("family_id");



CREATE INDEX "idx_family_members_user_id" ON "public"."family_members" USING "btree" ("user_id");



CREATE UNIQUE INDEX "idx_family_members_user_id_unique" ON "public"."family_members" USING "btree" ("user_id");



CREATE INDEX "idx_messages_session_created_at" ON "public"."messages" USING "btree" ("session_id", "created_at");



CREATE INDEX "idx_minutes_created_by" ON "public"."minutes" USING "btree" ("created_by");



CREATE INDEX "idx_minutes_embeddings_family_id" ON "public"."minutes_embeddings" USING "btree" ("family_id");



CREATE INDEX "idx_minutes_embeddings_hnsw" ON "public"."minutes_embeddings" USING "hnsw" ("embedding" "public"."vector_cosine_ops");



CREATE INDEX "idx_minutes_exclude_from_learning" ON "public"."minutes" USING "btree" ("exclude_from_learning");



CREATE INDEX "idx_minutes_family_id" ON "public"."minutes" USING "btree" ("family_id");



CREATE INDEX "idx_minutes_family_meeting_date" ON "public"."minutes" USING "btree" ("family_id", "meeting_date" DESC);



CREATE INDEX "idx_minutes_is_imported" ON "public"."minutes" USING "btree" ("is_imported");



CREATE INDEX "idx_minutes_meeting_date" ON "public"."minutes" USING "btree" ("meeting_date");



CREATE INDEX "idx_minutes_template_id" ON "public"."minutes" USING "btree" ("template_id");



CREATE INDEX "idx_minutes_tone_template" ON "public"."minutes" USING "btree" ((("tone_preference" ->> 'template_id'::"text")));



CREATE INDEX "idx_templates_family_id" ON "public"."templates" USING "btree" ("family_id");



CREATE INDEX "idx_templates_is_default" ON "public"."templates" USING "btree" ("is_default");



CREATE INDEX "idx_user_styles_family_id" ON "public"."user_styles" USING "btree" ("family_id");



CREATE INDEX "minutes_embeddings_family_id_idx" ON "public"."minutes_embeddings" USING "btree" ("family_id");



CREATE INDEX "reset_requests_family_created_idx" ON "public"."reset_requests" USING "btree" ("family_id", "created_at" DESC);



CREATE INDEX "signup_attempts_ip_created_idx" ON "public"."signup_attempts" USING "btree" ("ip", "created_at" DESC);



CREATE INDEX "user_consents_user_id_consented_at_idx" ON "public"."user_consents" USING "btree" ("user_id", "consented_at" DESC);



CREATE INDEX "user_styles_family_id_idx" ON "public"."user_styles" USING "btree" ("family_id");






CREATE OR REPLACE TRIGGER "trg_family_limits_autocreate" AFTER INSERT ON "public"."families" FOR EACH ROW EXECUTE FUNCTION "public"."create_family_limits_on_family_insert"();



CREATE OR REPLACE TRIGGER "trg_minutes_monthly_limit" BEFORE INSERT ON "public"."minutes" FOR EACH ROW EXECUTE FUNCTION "public"."check_minutes_monthly_limit"();



CREATE OR REPLACE TRIGGER "trg_templates_limit" BEFORE INSERT ON "public"."templates" FOR EACH ROW EXECUTE FUNCTION "public"."check_templates_limit"();



ALTER TABLE ONLY "public"."abuse_alerts"
    ADD CONSTRAINT "abuse_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chat_sessions"
    ADD CONSTRAINT "chat_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chat_sessions"
    ADD CONSTRAINT "chat_sessions_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_sessions"
    ADD CONSTRAINT "chat_sessions_minute_id_fkey" FOREIGN KEY ("minute_id") REFERENCES "public"."minutes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chat_sessions"
    ADD CONSTRAINT "chat_sessions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."family_limits"
    ADD CONSTRAINT "family_limits_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."family_members"
    ADD CONSTRAINT "family_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."minutes"
    ADD CONSTRAINT "minutes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."minutes_embeddings"
    ADD CONSTRAINT "minutes_embeddings_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."minutes_embeddings"
    ADD CONSTRAINT "minutes_embeddings_minutes_id_fkey" FOREIGN KEY ("minutes_id") REFERENCES "public"."minutes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."minutes"
    ADD CONSTRAINT "minutes_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."minutes"
    ADD CONSTRAINT "minutes_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."reset_requests"
    ADD CONSTRAINT "reset_requests_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reset_requests"
    ADD CONSTRAINT "reset_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_user_style_id_fkey" FOREIGN KEY ("user_style_id") REFERENCES "public"."user_styles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_consents"
    ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_styles"
    ADD CONSTRAINT "user_styles_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;



ALTER TABLE "public"."abuse_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_sessions_family_access" ON "public"."chat_sessions" USING (("family_id" = ( SELECT "family_members"."family_id"
   FROM "public"."family_members"
  WHERE ("family_members"."user_id" = "auth"."uid"())))) WITH CHECK (("family_id" = ( SELECT "family_members"."family_id"
   FROM "public"."family_members"
  WHERE ("family_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."families" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "families_insert" ON "public"."families" FOR INSERT WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "families_select" ON "public"."families" FOR SELECT USING ((("id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid") OR (EXISTS ( SELECT 1
   FROM "public"."family_members" "fm"
  WHERE (("fm"."family_id" = "families"."id") AND ("fm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "families_update" ON "public"."families" FOR UPDATE TO "authenticated" USING (("id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid")) WITH CHECK (("id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "family members read own family ai log" ON "public"."ai_usage_log" FOR SELECT USING (("family_id" IN ( SELECT "family_members"."family_id"
   FROM "public"."family_members"
  WHERE ("family_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "family members read own family limits" ON "public"."family_limits" FOR SELECT USING (("family_id" IN ( SELECT "family_members"."family_id"
   FROM "public"."family_members"
  WHERE ("family_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "family members read own reset requests" ON "public"."reset_requests" FOR SELECT USING (("family_id" IN ( SELECT "family_members"."family_id"
   FROM "public"."family_members"
  WHERE ("family_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."family_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."family_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "family_members_delete" ON "public"."family_members" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "family_members_insert" ON "public"."family_members" FOR INSERT WITH CHECK (false);



CREATE POLICY "family_members_select" ON "public"."family_members" FOR SELECT USING ((("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid") OR ("user_id" = "auth"."uid"())));



ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_family_access" ON "public"."messages" USING (("session_id" IN ( SELECT "chat_sessions"."id"
   FROM "public"."chat_sessions"
  WHERE ("chat_sessions"."family_id" = ( SELECT "family_members"."family_id"
           FROM "public"."family_members"
          WHERE ("family_members"."user_id" = "auth"."uid"())))))) WITH CHECK (("session_id" IN ( SELECT "chat_sessions"."id"
   FROM "public"."chat_sessions"
  WHERE ("chat_sessions"."family_id" = ( SELECT "family_members"."family_id"
           FROM "public"."family_members"
          WHERE ("family_members"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."minutes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "minutes_delete" ON "public"."minutes" FOR DELETE USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



ALTER TABLE "public"."minutes_embeddings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "minutes_embeddings_delete" ON "public"."minutes_embeddings" FOR DELETE TO "authenticated" USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "minutes_embeddings_insert" ON "public"."minutes_embeddings" FOR INSERT TO "authenticated" WITH CHECK (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "minutes_embeddings_select" ON "public"."minutes_embeddings" FOR SELECT TO "authenticated" USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "minutes_embeddings_update" ON "public"."minutes_embeddings" FOR UPDATE TO "authenticated" USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid")) WITH CHECK (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "minutes_insert" ON "public"."minutes" FOR INSERT WITH CHECK (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "minutes_select" ON "public"."minutes" FOR SELECT USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "minutes_update" ON "public"."minutes" FOR UPDATE TO "authenticated" USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid")) WITH CHECK (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



ALTER TABLE "public"."reset_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signup_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "templates_delete" ON "public"."templates" FOR DELETE USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "templates_insert" ON "public"."templates" FOR INSERT WITH CHECK ((("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid") AND ("is_default" = false)));



CREATE POLICY "templates_select" ON "public"."templates" FOR SELECT USING ((("is_default" = true) OR ("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid")));



CREATE POLICY "templates_update" ON "public"."templates" FOR UPDATE TO "authenticated" USING ((("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid") AND ("is_default" = false))) WITH CHECK ((("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid") AND ("is_default" = false)));



ALTER TABLE "public"."user_consents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_consents_insert_own" ON "public"."user_consents" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "user_consents_select_own" ON "public"."user_consents" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."user_styles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_styles_delete" ON "public"."user_styles" FOR DELETE TO "authenticated" USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "user_styles_insert" ON "public"."user_styles" FOR INSERT TO "authenticated" WITH CHECK (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "user_styles_select" ON "public"."user_styles" FOR SELECT TO "authenticated" USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));



CREATE POLICY "user_styles_update" ON "public"."user_styles" FOR UPDATE TO "authenticated" USING (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid")) WITH CHECK (("family_id" = (("auth"."jwt"() ->> 'family_id'::"text"))::"uuid"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";








GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";



GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_out"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_send"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_out"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_send"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_in"("cstring", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_out"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_recv"("internal", "oid", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_send"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_typmod_in"("cstring"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(real[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(double precision[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(integer[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_halfvec"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_sparsevec"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."array_to_vector"(numeric[], integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_float4"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_sparsevec"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_to_vector"("public"."halfvec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_to_halfvec"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_to_vector"("public"."sparsevec", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_float4"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_halfvec"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_to_sparsevec"("public"."vector", integer, boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector"("public"."vector", integer, boolean) TO "service_role";











































































































































































REVOKE ALL ON FUNCTION "public"."ai_usage_exceeded"("p_family_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ai_usage_exceeded"("p_family_id" "uuid", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ai_usage_exceeded"("p_family_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ai_usage_exceeded"("p_family_id" "uuid", "p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."binary_quantize"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_minutes_monthly_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_minutes_monthly_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_minutes_monthly_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_templates_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_templates_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_templates_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cosine_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_family_limits_on_family_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_family_limits_on_family_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_family_limits_on_family_insert"() TO "service_role";



GRANT ALL ON TABLE "public"."families" TO "anon";
GRANT ALL ON TABLE "public"."families" TO "authenticated";
GRANT ALL ON TABLE "public"."families" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_family_with_owner"("p_family_name" "text", "p_display_name" "text", "p_invite_code" "text", "p_invite_code_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_family_with_owner"("p_family_name" "text", "p_display_name" "text", "p_invite_code" "text", "p_invite_code_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_family_with_owner"("p_family_name" "text", "p_display_name" "text", "p_invite_code" "text", "p_invite_code_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "supabase_auth_admin";



GRANT ALL ON FUNCTION "public"."delete_minute_with_files"("p_minute_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_minute_with_files"("p_minute_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_minute_with_files"("p_minute_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_accum"(double precision[], "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_add"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_avg"(double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_cmp"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_combine"(double precision[], double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_concat"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_eq"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_ge"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_gt"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_l2_squared_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_le"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_lt"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_mul"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_ne"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_negative_inner_product"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_spherical_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."halfvec_sub"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "postgres";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "anon";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "authenticated";
GRANT ALL ON FUNCTION "public"."hamming_distance"(bit, bit) TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_bit_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_halfvec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnsw_sparsevec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hnswhandler"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."inner_product"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflat_bit_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflat_halfvec_support"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ivfflathandler"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "postgres";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "anon";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "authenticated";
GRANT ALL ON FUNCTION "public"."jaccard_distance"(bit, bit) TO "service_role";



REVOKE ALL ON FUNCTION "public"."join_family_by_invite_code"("p_code" "text", "p_display_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_family_by_invite_code"("p_code" "text", "p_display_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_family_by_invite_code"("p_code" "text", "p_display_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l1_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."halfvec", "public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_norm"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."l2_normalize"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "p_family_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "p_family_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_documents"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer, "p_family_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."regenerate_family_invite_code"("p_family_id" "uuid", "p_new_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regenerate_family_invite_code"("p_family_id" "uuid", "p_new_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regenerate_family_invite_code"("p_family_id" "uuid", "p_new_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."reset_request_exists_today_jst"("p_family_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reset_request_exists_today_jst"("p_family_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reset_request_exists_today_jst"("p_family_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_cmp"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_eq"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_ge"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_gt"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_l2_squared_distance"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_le"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_lt"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_ne"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "anon";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sparsevec_negative_inner_product"("public"."sparsevec", "public"."sparsevec") TO "service_role";



GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "anon";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."subvector"("public"."halfvec", integer, integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "anon";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."subvector"("public"."vector", integer, integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_accum"(double precision[], "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_add"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_avg"(double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_cmp"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_combine"(double precision[], double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_concat"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_dims"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_eq"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_ge"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_gt"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_l2_squared_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_le"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_lt"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_mul"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_ne"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_negative_inner_product"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_norm"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_spherical_distance"("public"."vector", "public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vector_sub"("public"."vector", "public"."vector") TO "service_role";












GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."avg"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."avg"("public"."vector") TO "service_role";



GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "postgres";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "anon";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sum"("public"."halfvec") TO "service_role";



GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "postgres";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "anon";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sum"("public"."vector") TO "service_role";















GRANT ALL ON TABLE "public"."abuse_alerts" TO "anon";
GRANT ALL ON TABLE "public"."abuse_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."abuse_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage_log" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage_log" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage_log" TO "service_role";



GRANT ALL ON TABLE "public"."chat_sessions" TO "anon";
GRANT ALL ON TABLE "public"."chat_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."family_limits" TO "anon";
GRANT ALL ON TABLE "public"."family_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."family_limits" TO "service_role";



GRANT ALL ON TABLE "public"."family_members" TO "anon";
GRANT ALL ON TABLE "public"."family_members" TO "authenticated";
GRANT ALL ON TABLE "public"."family_members" TO "service_role";
GRANT SELECT ON TABLE "public"."family_members" TO "supabase_auth_admin";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."minutes" TO "anon";
GRANT ALL ON TABLE "public"."minutes" TO "authenticated";
GRANT ALL ON TABLE "public"."minutes" TO "service_role";



GRANT ALL ON TABLE "public"."minutes_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."minutes_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."minutes_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."reset_requests" TO "anon";
GRANT ALL ON TABLE "public"."reset_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."reset_requests" TO "service_role";



GRANT ALL ON TABLE "public"."signup_attempts" TO "anon";
GRANT ALL ON TABLE "public"."signup_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."signup_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."templates" TO "anon";
GRANT ALL ON TABLE "public"."templates" TO "authenticated";
GRANT ALL ON TABLE "public"."templates" TO "service_role";



GRANT ALL ON TABLE "public"."user_consents" TO "anon";
GRANT ALL ON TABLE "public"."user_consents" TO "authenticated";
GRANT ALL ON TABLE "public"."user_consents" TO "service_role";



GRANT ALL ON TABLE "public"."user_styles" TO "anon";
GRANT ALL ON TABLE "public"."user_styles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_styles" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

































SELECT pg_catalog.set_config('search_path', 'public', false);
