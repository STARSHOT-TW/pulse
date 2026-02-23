import { Component, createResource, createSignal, createEffect, onCleanup, For, Show } from 'solid-js';

interface LogMessage {
    timestamp: string;
    source: string;
    message: string;
    level: string; // raw value from Graylog, e.g. "6", "info", "3", "error"
}

interface LogsTabProps {
    vmName: string;
}

// Normalise syslog numeric level or text label → display label + colour class.
function parseLevel(raw: string): { label: string; cls: string } {
    const n = parseInt(raw, 10);
    if (!isNaN(n)) {
        const labels = ['EMERG', 'ALERT', 'CRIT', 'ERROR', 'WARN', 'NOTICE', 'INFO', 'DEBUG'];
        const label = labels[n] ?? `LVL${n}`;
        const cls = n <= 3 ? 'text-red-400' : n === 4 ? 'text-yellow-400' : n === 5 ? 'text-blue-400' : 'text-gray-400';
        return { label, cls };
    }
    // Text labels (some Graylog setups emit "error", "warning", etc.)
    const upper = raw.toUpperCase();
    const cls = ['EMERG','ALERT','CRIT','ERROR','FATAL'].includes(upper)
        ? 'text-red-400'
        : ['WARN','WARNING'].includes(upper)
            ? 'text-yellow-400'
            : ['NOTICE','INFO'].includes(upper)
                ? 'text-blue-400'
                : 'text-gray-400';
    return { label: upper || 'LOG', cls };
}

const formatTs = (ts: string) =>
    new Date(ts).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

export const LogsTab: Component<LogsTabProps> = (props) => {
    const [tick, setTick] = createSignal(0);
    const [autoRefresh, setAutoRefresh] = createSignal(false);

    const [data] = createResource(
        () => ({ vm: props.vmName, tick: tick() }),
        async ({ vm }) => {
            const res = await fetch(`/api/graylog/logs?vm=${encodeURIComponent(vm)}&limit=10`);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`${res.status} – ${text.trim()}`);
            }
            return res.json() as Promise<{ logs: LogMessage[]; count: number; vm: string }>;
        }
    );

    let timer: ReturnType<typeof setInterval> | undefined;
    createEffect(() => {
        if (timer !== undefined) { clearInterval(timer); timer = undefined; }
        if (autoRefresh()) timer = setInterval(() => setTick(t => t + 1), 10_000);
    });
    onCleanup(() => { if (timer !== undefined) clearInterval(timer); });

    return (
        <div class="space-y-3 p-1">
            {/* Toolbar */}
            <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-gray-300">
                    Recent Logs
                    <Show when={data.state === 'ready'}>
                        <span class="ml-1 text-gray-500">({data()?.count ?? 0})</span>
                    </Show>
                </span>

                <div class="flex items-center gap-3">
                    <label class="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={autoRefresh()}
                            onChange={e => setAutoRefresh(e.currentTarget.checked)}
                            class="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-0 focus:ring-offset-0"
                        />
                        Auto (10s)
                    </label>
                    <button
                        onClick={() => setTick(t => t + 1)}
                        disabled={data.loading}
                        class="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        <svg class={`w-3 h-3 ${data.loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Refresh
                    </button>
                </div>
            </div>

            {/* Loading */}
            <Show when={data.loading && !data()}>
                <div class="flex items-center justify-center py-10">
                    <div class="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full" />
                </div>
            </Show>

            {/* Error */}
            <Show when={data.error}>
                <div class="flex items-start gap-2 p-3 rounded bg-red-900/20 border border-red-500/30 text-sm">
                    <svg class="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                        <p class="font-medium text-red-400">Failed to load logs</p>
                        <p class="text-red-300 text-xs mt-0.5">{String(data.error)}</p>
                    </div>
                </div>
            </Show>

            {/* Empty */}
            <Show when={data.state === 'ready' && data()?.logs.length === 0}>
                <p class="text-center py-10 text-sm text-gray-500">No logs found for {props.vmName}</p>
            </Show>

            {/* Log rows */}
            <Show when={data.state === 'ready' && (data()?.logs.length ?? 0) > 0}>
                <div class="space-y-1.5">
                    <For each={data()!.logs}>
                        {(log) => {
                            const { label, cls } = parseLevel(log.level);
                            return (
                                <div class="rounded border border-gray-700 bg-gray-800/50 hover:bg-gray-800 transition-colors p-2.5">
                                    <div class="flex items-start gap-2">
                                        <span class={`text-[10px] font-mono font-bold uppercase shrink-0 pt-px w-12 ${cls}`}>
                                            {label}
                                        </span>
                                        <span class="text-xs text-gray-300 font-mono break-all leading-relaxed">
                                            {log.message}
                                        </span>
                                    </div>
                                    <p class="text-[10px] text-gray-500 mt-1 pl-14">
                                        {formatTs(log.timestamp)} · {log.source}
                                    </p>
                                </div>
                            );
                        }}
                    </For>
                </div>
            </Show>
        </div>
    );
};
