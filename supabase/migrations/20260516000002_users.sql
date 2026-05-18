-- Migration: users table (mirrors auth.users with app-level fields)

CREATE TABLE public.users (
  id                      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                   text UNIQUE NOT NULL,
  display_name            text,
  avatar_url              text,
  tier                    text NOT NULL DEFAULT 'free'
                            CHECK (tier IN ('free', 'personal', 'pro')),
  stripe_customer_id      text UNIQUE,
  region                  text NOT NULL DEFAULT 'eu-central-1',
  locale                  text NOT NULL DEFAULT 'fr',
  onboarding_completed_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);

CREATE INDEX idx_users_stripe ON public.users (stripe_customer_id);
CREATE INDEX idx_users_deleted ON public.users (deleted_at) WHERE deleted_at IS NOT NULL;

-- Auto-create public.users row on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- updated_at auto
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_read_own ON public.users
  FOR SELECT USING (id = auth.uid());

CREATE POLICY users_update_own ON public.users
  FOR UPDATE USING (id = auth.uid());
