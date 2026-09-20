import { defineMiddleware } from 'astro:middleware';
import { getSessionUser, isGuildAdmin, isGuildMember, isGuildOfficer } from './lib/auth';
import { env } from 'cloudflare:workers';

const MEMBER_ONLY_PATHS = new Set(['/raiders', '/signup', '/feedback', '/trinkets']);

// Admin pages open to officers (rank 0–3) as well as admins. Everything else
// under /admin stays admin-only (rank 0–2).
const OFFICER_ADMIN_PATHS = new Set(['/admin', '/admin/log-matching']);

// Guild is on hiatus between seasons — redirect raider/tool features to the hiatus page.
const HIATUS_PATHS = new Set(['/signup', '/trinkets', '/loot-history', '/upgrades']);

function requireAuthenticatedGuildMember(
	path: string,
	user: App.Locals['user'],
	isGuildMember: boolean,
	redirect: (path: string) => Response
): Response | null {
	const isProtected = MEMBER_ONLY_PATHS.has(path) || path.startsWith('/raiders/');
	if (!isProtected) {
		return null;
	}

	if (!user) {
		return redirect('/auth/login');
	}

	if (!isGuildMember) {
		return new Response('Guild membership required.', { status: 403 });
	}

	return null;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const user = await getSessionUser(env.DB, context.request);
	context.locals.user = user;
	context.locals.isGuildMember = user ? await isGuildMember(env.DB, user.id) : false;
	context.locals.isAdmin = user ? await isGuildAdmin(env.DB, user.id) : false;
	context.locals.isOfficer = context.locals.isAdmin || (user ? await isGuildOfficer(env.DB, user.id) : false);

	const path = new URL(context.request.url).pathname;

	// Redirect raider/tool features to the hiatus page during guild break between seasons.
	if (HIATUS_PATHS.has(path)) {
		return context.redirect('/hiatus');
	}

	// Guard all /admin/* routes at the middleware level
	const isAdminPage = path.startsWith('/admin');
	const isAdminApi = path.startsWith('/api/admin');
	const isAdminSurface = isAdminPage || isAdminApi;
	if (isAdminPage) {
		if (!user) {
			return context.redirect('/auth/login');
		}
		const isOfficerPage = OFFICER_ADMIN_PATHS.has(path.replace(/\/+$/, '') || '/');
		if (!context.locals.isAdmin && !(isOfficerPage && context.locals.isOfficer)) {
			return new Response('Forbidden', { status: 403 });
		}
	}

	const memberRouteResponse = requireAuthenticatedGuildMember(
		path,
		user,
		context.locals.isGuildMember,
		(routePath) => context.redirect(routePath)
	);
	if (memberRouteResponse) {
		return memberRouteResponse;
	}

	const response = await next();

	if (isAdminSurface) {
		response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
		response.headers.set('Pragma', 'no-cache');
		response.headers.set('Expires', '0');
		response.headers.append('Vary', 'Cookie');
	}

	return response;
});
