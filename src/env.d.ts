/// <reference types="astro/client" />

interface CloudflareEnv {
	DB: import("@cloudflare/workers-types").D1Database;
	BLIZZARD_CLIENT_ID: string;
	BLIZZARD_CLIENT_SECRET: string;
	BLIZZARD_REDIRECT_URI: string;
	CRON_SECRET?: string;
}

declare module 'cloudflare:workers' {
	export const env: CloudflareEnv;
}

declare namespace App {
	interface Locals {
		user: {
			id: number;
			battleTag: string;
			blizzardId: number;
		} | null;
		isAdmin: boolean;
	}
}
