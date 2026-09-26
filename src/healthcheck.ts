/**
 * The container healthcheck. Run as `node dist/healthcheck.js /readyz`.
 *
 * Deliberately a separate tiny process rather than curl or wget: the image
 * does not need to ship an HTTP client just to answer Docker's question, and
 * the exit code is the whole contract.
 */
const path = process.argv[2] ?? '/healthz';
const port = process.env.PORT ?? '8080';
const url = `http://127.0.0.1:${port}${path}`;

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (res.ok) {
    process.exit(0);
  }
  const body = await res.text().catch(() => '');
  process.stderr.write(`healthcheck ${path} -> ${res.status} ${body.slice(0, 300)}\n`);
  process.exit(1);
} catch (err) {
  process.stderr.write(`healthcheck ${path} failed: ${(err as Error).message}\n`);
  process.exit(1);
}
