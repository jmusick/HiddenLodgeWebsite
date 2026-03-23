/// <reference types="astro/client" />

interface CloudflareEnv {
	DB: import("@cloudflare/workers-types").D1Database;
	BLIZZARD_CLIENT_ID: string;
	BLIZZARD_CLIENT_SECRET: string;
	BLIZZARD_REDIRECT_URI: string;
	WCL_CLIENT_ID?: string;
	WCL_CLIENT_SECRET?: string;
	CRON_SECRET?: string;
	SIM_RUNNER_KEY?: string;
	WOWSIM_APP_BASE_URL?: string;
	WOWSIM_APP_API_KEY?: string;
	WOWSIM_APP_TRIGGER_PATH?: string;
	WOWSIM_APP_STATUS_PATH?: string;
	RAID_PROGRESS_TARGET?: string;
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
		isGuildMember: boolean;
		isAdmin: boolean;
	}
}
