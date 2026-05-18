-- Migration: pgcrypto helpers for OAuth token encryption (Supabase Cloud).
--
-- The encryption key MUST live in Vault under the secret name 'mesh_token_key'.
-- Set it from the dashboard or via SQL:
--   SELECT vault.create_secret('your-32+-char-key', 'mesh_token_key', 'Mesh OAuth token encryption key');
--
-- If the secret is missing on first install, the helpers raise a clear error
-- instead of silently using an unsafe default.

CREATE OR REPLACE FUNCTION public._mesh_token_key() RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  k text;
BEGIN
  -- Prefer Vault (Supabase Cloud canonical place for secrets)
  BEGIN
    SELECT decrypted_secret INTO k
      FROM vault.decrypted_secrets
      WHERE name = 'mesh_token_key'
      LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    k := NULL;
  END;

  IF k IS NOT NULL AND length(k) >= 32 THEN
    RETURN k;
  END IF;

  -- Fallback: GUC (set with `ALTER DATABASE ... SET app.mesh_token_key`)
  BEGIN
    k := current_setting('app.mesh_token_key', true);
  EXCEPTION WHEN OTHERS THEN
    k := NULL;
  END;

  IF k IS NULL OR length(k) < 32 THEN
    RAISE EXCEPTION 'mesh_token_key is missing or too short. Create the Vault secret named "mesh_token_key" (>=32 chars).';
  END IF;
  RETURN k;
END;
$$;

CREATE OR REPLACE FUNCTION public.encrypt_token(p_token text) RETURNS text
LANGUAGE sql
STRICT
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT encode(
    extensions.pgp_sym_encrypt(p_token, public._mesh_token_key()),
    'base64'
  );
$$;

CREATE OR REPLACE FUNCTION public.decrypt_token(p_encrypted text) RETURNS text
LANGUAGE sql
STRICT
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT extensions.pgp_sym_decrypt(
    decode(p_encrypted, 'base64'),
    public._mesh_token_key()
  );
$$;

REVOKE EXECUTE ON FUNCTION public.encrypt_token(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.encrypt_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_token(text) TO service_role;
