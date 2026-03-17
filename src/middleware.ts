import { defineMiddleware } from 'astro:middleware';
import { getSessionUser } from './lib/auth';
import { env } from 'cloudflare:workers';

export const onRequest = defineMiddleware(async (context, next) => {
	context.locals.user = await getSessionUser(env.DB, context.request);
	return next();
});
