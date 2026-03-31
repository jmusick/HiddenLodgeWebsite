export const prerender = false;

import type { APIContext } from 'astro';

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.user || (!context.locals.isGuildMember && !context.locals.isAdmin)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return Response.json(
    {
      error: 'Manual sim launches are disabled. Droptimizer sims now run automatically in the background.',
      manual_launch_enabled: false,
    },
    { status: 403 }
  );
}

export async function GET(context: APIContext): Promise<Response> {
  if (!context.locals.user || (!context.locals.isGuildMember && !context.locals.isAdmin)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return Response.json({
    online: false,
    remote_mode: true,
    manual_launch_enabled: false,
    message: 'Manual sim launches are disabled. Droptimizer sims are automated via passive runner tasks.',
  });
}
