-- Migration: RGPD helpers — account deletion request, data export view

-- Soft-delete trigger for account deletion request
CREATE OR REPLACE FUNCTION public.request_account_deletion(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized account deletion request';
  END IF;

  UPDATE public.users
    SET deleted_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.audit_log (user_id, operation, metadata)
  VALUES (
    p_user_id,
    'account.wipe_requested',
    jsonb_build_object('scheduled_at', now() + interval '72 hours')
  );
END;
$$;

-- Hard delete (called by background worker after 72h grace)
CREATE OR REPLACE FUNCTION public.execute_account_wipe(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_grace_passed boolean;
BEGIN
  SELECT (deleted_at IS NOT NULL AND deleted_at < now() - interval '72 hours')
    INTO v_grace_passed
    FROM public.users
    WHERE id = p_user_id;

  IF NOT COALESCE(v_grace_passed, false) THEN
    RAISE EXCEPTION 'Cannot wipe — grace period not passed';
  END IF;

  -- Cascade DELETE drops nodes, edges, injections, connectors, rules, usage
  DELETE FROM public.users WHERE id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;

  -- audit_log entry preserved (immutable, user_id orphan but no FK)
  INSERT INTO public.audit_log (user_id, operation)
  VALUES (p_user_id, 'account.wipe_executed');
END;
$$;

-- Data export view (for RGPD portability)
-- Returns the user's data as JSON, called via Edge Function with service role
CREATE OR REPLACE FUNCTION public.export_user_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized export request';
  END IF;

  SELECT jsonb_build_object(
    'exported_at', now(),
    'user', (SELECT row_to_json(u) FROM public.users u WHERE u.id = p_user_id),
    'nodes', COALESCE((
      SELECT jsonb_agg(row_to_json(n))
      FROM public.context_nodes n
      WHERE n.user_id = p_user_id
    ), '[]'::jsonb),
    'edges', COALESCE((
      SELECT jsonb_agg(row_to_json(e))
      FROM public.context_edges e
      WHERE e.user_id = p_user_id
    ), '[]'::jsonb),
    'connectors', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'provider', c.provider,
          'status', c.status,
          'created_at', c.created_at,
          'last_sync_at', c.last_sync_at
        )
      )
      FROM public.connectors c
      WHERE c.user_id = p_user_id
    ), '[]'::jsonb),
    'rules', COALESCE((
      SELECT jsonb_agg(row_to_json(r))
      FROM public.context_rules r
      WHERE r.user_id = p_user_id
    ), '[]'::jsonb),
    'audit', COALESCE((
      SELECT jsonb_agg(row_to_json(a))
      FROM public.audit_log a
      WHERE a.user_id = p_user_id
      ORDER BY a.created_at DESC
      LIMIT 5000
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;
