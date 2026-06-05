/**
 * FounderOS analytics SDK — JavaScript / TypeScript.
 *
 * Works in two runtimes from one file:
 *   - Browser: event tracking + optional rrweb session replay recording.
 *   - Node / Deno / Bun (server): event tracking with batching, API-key auth.
 *
 * Endpoints (Supabase edge functions):
 *   POST {host}/functions/v1/track-event           — product events
 *   POST {host}/functions/v1/ingest-session-replay  — rrweb batches (browser)
 *
 * Browser auth uses the anon key + workspaceId. Server auth uses an \`fos_\` API
 * key (issued in Integrations → API Keys) via the Authorization header; the
 * workspace is then resolved from the key, so only projectId is required.
 */

export interface FounderOSConfig {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  host: string;
  /** The project (cockpit) you are sending events for. */
  projectId: string;
  /** Workspace id — required in the browser; omit on the server when using apiKey. */
  workspaceId?: string;
  /** Supabase anon key — required in the browser. */
  anonKey?: string;
  /** Server API key (\`fos_...\`) — server only; never expose in the browser. */
  apiKey?: string;
  /** Flush the queue automatically every N ms (default 5000). 0 disables. */
  flushIntervalMs?: number;
  /** Max events buffered before an automatic flush (default 20). */
  batchSize?: number;
  /** Enable console diagnostics. */
  debug?: boolean;
}

export interface TrackOptions {
  /** Stable user identifier — an email or your own id. */
  distinctId?: string;
  /** Arbitrary event properties. */
  properties?: Record<string, unknown>;
  /** Override the event time (ISO string). Defaults to now. */
  occurredAt?: string;
}

interface QueuedEvent {
  event_name: string;
  distinct_id?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

export class FounderOS {
  private cfg: Required<Pick<FounderOSConfig, "flushIntervalMs" | "batchSize">> & FounderOSConfig;
  private queue: QueuedEvent[] = [];
  private distinctId?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recorderStop: (() => void) | null = null;

  constructor(config: FounderOSConfig) {
    this.cfg = { flushIntervalMs: 5000, batchSize: 20, ...config };
    if (!this.cfg.host || !this.cfg.projectId) {
      throw new Error("FounderOS: host and projectId are required");
    }
    if (isBrowser && !this.cfg.anonKey) {
      this.log("warning: no anonKey set — browser ingestion will be rejected");
    }
    if (this.cfg.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
      // Don't keep a Node process alive just for the flush timer.
      (this.timer as { unref?: () => void }).unref?.();
    }
    if (isBrowser) {
      // Best-effort flush when the tab is hidden / closed.
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void this.flush(true);
      });
    }
  }

  /** Associate subsequent events with a user. */
  identify(distinctId: string, properties?: Record<string, unknown>): void {
    this.distinctId = distinctId;
    if (properties) this.track("$identify", { distinctId, properties });
  }

  /** Queue an event. It is sent on the next flush (or immediately if full). */
  track(eventName: string, opts: TrackOptions = {}): void {
    this.queue.push({
      event_name: eventName,
      distinct_id: opts.distinctId ?? this.distinctId,
      properties: opts.properties,
      occurred_at: opts.occurredAt,
    });
    if (this.queue.length >= this.cfg.batchSize) void this.flush();
  }

  /** Send all queued events now. \`keepalive\` uses fetch keepalive for unloads. */
  async flush(keepalive = false): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.post(
        "track-event",
        { project_id: this.cfg.projectId, workspace_id: this.cfg.workspaceId, batch },
        keepalive,
      );
      this.log(\`flushed \${batch.length} events\`);
    } catch (err) {
      // Re-queue on failure so events aren't lost (bounded to avoid unbounded growth).
      this.queue = [...batch, ...this.queue].slice(0, 1000);
      this.log(\`flush failed, re-queued: \${(err as Error).message}\`);
    }
  }

  /**
   * Browser-only: start recording a session replay with rrweb. Pass the rrweb
   * \`record\` function (so the host app controls the rrweb version/bundle):
   *
   *   import { record } from "rrweb";
   *   fos.startSessionRecording(record, { maskAllInputs: true });
   *
   * Events are batched and shipped to ingest-session-replay. Returns a stop fn.
   */
  startSessionRecording(
    record: (opts: Record<string, unknown>) => (() => void) | undefined,
    rrwebOptions: Record<string, unknown> = {},
  ): () => void {
    if (!isBrowser) {
      this.log("startSessionRecording is a no-op outside the browser");
      return () => {};
    }
    const clientSessionId = this.uuid();
    let chunk = 0;
    let buffer: unknown[] = [];
    let rageWindow: number[] = [];
    let rageClicks = 0;
    let errors = 0;

    const shipChunk = (final = false) => {
      if (buffer.length === 0) return;
      const events = buffer;
      buffer = [];
      const meta =
        chunk === 0
          ? {
              entry_url: location.href,
              user_agent: navigator.userAgent,
              device: this.guessDevice(),
              user_email: this.distinctId?.includes("@") ? this.distinctId : undefined,
              customer_external_id: this.distinctId && !this.distinctId.includes("@") ? this.distinctId : undefined,
            }
          : undefined;
      void this.post(
        "ingest-session-replay",
        {
          workspace_id: this.cfg.workspaceId,
          project_id: this.cfg.projectId,
          client_session_id: clientSessionId,
          chunk: chunk++,
          events,
          meta,
          signals: { rage_clicks: rageClicks, errors, pages: 1 },
        },
        final,
      ).catch((e) => this.log(\`replay ship failed: \${(e as Error).message}\`));
      rageClicks = 0;
      errors = 0;
    };

    // rrweb emit → buffer; ship on size or interval.
    const stopRecord = record({
      emit: (event: unknown) => {
        buffer.push(event);
        if (buffer.length >= 100) shipChunk();
      },
      maskAllInputs: true,
      ...rrwebOptions,
    });

    // Rage-click heuristic: 3+ clicks within 800ms at roughly the same spot.
    const onClick = (e: MouseEvent) => {
      const now = Date.now();
      rageWindow = rageWindow.filter((t) => now - t < 800);
      rageWindow.push(now);
      if (rageWindow.length >= 3) {
        rageClicks++;
        rageWindow = [];
      }
      void e;
    };
    const onError = () => {
      errors++;
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);

    const interval = setInterval(() => shipChunk(), 5000);
    const onHide = () => {
      if (document.visibilityState === "hidden") shipChunk(true);
    };
    window.addEventListener("visibilitychange", onHide);

    this.recorderStop = () => {
      clearInterval(interval);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("visibilitychange", onHide);
      stopRecord?.();
      shipChunk(true);
    };
    return this.recorderStop;
  }

  /** Stop recording and flush everything. Call on shutdown. */
  async shutdown(): Promise<void> {
    this.recorderStop?.();
    this.recorderStop = null;
    if (this.timer) clearInterval(this.timer);
    await this.flush(true);
  }

  // ── internals ──
  private async post(fn: string, body: unknown, keepalive = false): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) headers["Authorization"] = \`Bearer \${this.cfg.apiKey}\`;
    if (this.cfg.anonKey) headers["apikey"] = this.cfg.anonKey;
    const res = await fetch(\`\${this.cfg.host}/functions/v1/\${fn}\`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      keepalive: keepalive && isBrowser,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(\`\${fn} \${res.status}: \${text.slice(0, 200)}\`);
    }
  }

  private guessDevice(): string {
    const ua = navigator.userAgent;
    if (/iPad|Tablet/i.test(ua)) return "tablet";
    if (/Mobi|Android|iPhone/i.test(ua)) return "mobile";
    return "desktop";
  }

  private uuid(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  private log(msg: string): void {
    if (this.cfg.debug) console.log(\`[founderos] \${msg}\`);
  }
}

/** Convenience factory. */
export function createClient(config: FounderOSConfig): FounderOS {
  return new FounderOS(config);
}
