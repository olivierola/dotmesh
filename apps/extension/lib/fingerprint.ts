export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function fingerprintOf(source: string, content: string): Promise<string> {
  return sha256Hex(`${source}|${content.trim().slice(0, 4000)}`);
}
