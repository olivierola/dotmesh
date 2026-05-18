import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string) || 'http://127.0.0.1:54321';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || 'placeholder-anon-key';

if (!import.meta.env.VITE_SUPABASE_ANON_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mesh] VITE_SUPABASE_ANON_KEY is missing. Auth and API calls will fail until you run `pnpm supabase:start` and paste the anon key into apps/web/.env.local',
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce', // OAuth + magic-link both use PKCE; required for exchangeCodeForSession
    storageKey: 'mesh-auth',
  },
});
