import type { IncomingMessage, ServerResponse } from 'node:http';

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

let appPromise: Promise<RequestHandler> | null = null;

async function getApp(): Promise<RequestHandler> {
  if (!appPromise) {
    appPromise = (async () => {
      const { createApp } = await import('../server.js');
      return (await createApp()) as unknown as RequestHandler;
    })();
  }
  try {
    return await appPromise;
  } catch (err) {
    appPromise = null;
    throw err;
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    console.error('Vercel API handler error:', err);
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ok: false,
          status: 'degraded',
          error: message,
        })
      );
    }
  }
}
