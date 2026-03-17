import { defineMiddleware } from 'astro:middleware';
import { getSessionUser, isGuildAdmin } from './lib/auth';
import { env } from 'cloudflare:workers';

export const onRequest = defineMiddleware(async (context, next) => {
	const user = await getSessionUser(env.DB, context.request);
	context.locals.user = user;
	context.locals.isAdmin = user ? await isGuildAdmin(env.DB, user.id) : false;

	// Guard all /admin/* routes at the middleware level
	const path = new URL(context.request.url).pathname;
	if (path.startsWith('/admin')) {
		if (!user) {
			return context.redirect('/auth/login');
		}
		if (!context.locals.isAdmin) {
			return new Response('Forbidden', { status: 403 });
		}
	}

	return next();
});
