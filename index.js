/**
 * Host half of dsh-aura.
 *
 * v0.4 serves one diagnostic route so the browser half can report how far it
 * got: a slot entry that never mounts looks exactly like a plugin that is not
 * installed, and the renderer console is not reachable from outside the app.
 * Everything the pane reports lands as one JSON object per line in
 * `$DSH_HOME/aura-diag.jsonl`.
 *
 * Session control and the speech pipeline land here once the pane is trusted to
 * render.
 */
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const inject = ['webServer'];

/** One line per report; trimmed so a runaway loop cannot fill the disk. */
const MAX_LINES = 2000;

function logFile() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return path.join(home, 'aura-diag.jsonl');
}

async function append(line) {
  const file = logFile();
  try {
    await appendFile(file, line + '\n', 'utf8');
  } catch {
    /* A diagnostic must never break the thing it observes. */
    return;
  }
  try {
    const { readFile, writeFile } = await import('node:fs/promises');
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    if (lines.length > MAX_LINES) {
      await writeFile(file, lines.slice(lines.length - MAX_LINES).join('\n'), 'utf8');
    }
  } catch {
    /* trimming is best effort */
  }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/aura/diag',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          let body = '';
          try {
            for await (const chunk of req) body += chunk;
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
          const text = body.trim().slice(0, 4000);
          if (text) await append(text.startsWith('{') ? text : JSON.stringify({ raw: text }));
          res.writeHead(204);
          res.end();
        },
      }),
    'dsh-aura: diagnostic route',
  );
}
