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
    // We use the implicit (hash-based) flow rather than PKCE so magic
    // links work cross-device. PKCE requires the verifier from the
    // initiating device to be present at the callback — fine for OAuth
    // where the browser round-trip stays local, broken for magic links
    // when the user clicks the email on their phone but started on their
    // desktop. Implicit flow embeds the access_token directly in the URL
    // hash, no verifier required.
    flowType: 'implicit',
    storageKey: 'mesh-auth',
  },
});
