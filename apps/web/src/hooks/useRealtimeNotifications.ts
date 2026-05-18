import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { api } from '@/lib/api-client';

/**
 * Subscribes to realtime INSERTs on context_nodes for the current user.
 * Returns the count of new nodes since the hook mounted.
 *
 * In mock mode, simulates one fake notification every 30s so the UI is testable.
 */
export function useRealtimeNotifications(): {
  newCount: number;
  reset: () => void;
} {
  const [newCount, setNewCount] = useState(0);

  useEffect(() => {
    if (api.isMock) {
      const t = setInterval(() => setNewCount((n) => n + 1), 30_000);
      return () => clearInterval(t);
    }

    let userId: string | null = null;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const { data } = await supabase.auth.getUser();
      userId = data.user?.id ?? null;
      if (!userId) return;

      channel = supabase
        .channel(`mesh-user-${userId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'context_nodes',
            filter: `user_id=eq.${userId}`,
          },
          () => setNewCount((n) => n + 1),
        )
        .subscribe();
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  return { newCount, reset: () => setNewCount(0) };
}
