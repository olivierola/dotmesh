// FounderOS analytics — server init. Never expose the API key to the browser.
import { createClient } from "./founderos";

export const analytics = createClient({
  host: "https://scugmxahflsjabglodyv.supabase.co",
  projectId: "3af40f57-761d-4a0b-9209-66ccbaeb47b6",
  apiKey: process.env.FOUNDEROS_API_KEY,
});

// Flush on shutdown so no events are lost.
// process.on("beforeExit", () => analytics.shutdown());
