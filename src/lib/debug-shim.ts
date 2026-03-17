type DebugFn = ((...args: unknown[]) => void) & {
	enabled: boolean;
	namespace: string;
	extend: (namespace: string, delimiter?: string) => DebugFn;
	destroy: () => boolean;
};

type DebugFactory = ((namespace: string) => DebugFn) & {
	enable: (namespaces?: string) => void;
	disable: () => string;
	enabled: (namespace: string) => boolean;
	coerce: (value: unknown) => unknown;
	formatters: Record<string, (value: unknown) => string>;
};

const createDebug = ((namespace: string): DebugFn => {
	const fn = ((..._args: unknown[]) => {
		// Intentionally no-op in Cloudflare local runner compatibility mode.
	}) as DebugFn;

	fn.enabled = false;
	fn.namespace = namespace;
	fn.extend = (extraNamespace: string, delimiter = ':') =>
		createDebug(`${namespace}${delimiter}${extraNamespace}`);
	fn.destroy = () => true;
	return fn;
}) as DebugFactory;

createDebug.enable = () => {};
createDebug.disable = () => '';
createDebug.enabled = () => false;
createDebug.coerce = (value: unknown) => value;
createDebug.formatters = {};

export default createDebug;
