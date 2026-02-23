import { Component, createResource, createSignal, createEffect, onCleanup, Show } from 'solid-js';

interface LogsTabProps {
    vmName: string;
}

export const LogsTab: Component<LogsTabProps> = (props) => {
    const [tick, setTick] = createSignal(0);
    const [autoRefresh, setAutoRefresh] = createSignal(false);

    const [data] = createResource(
        () => ({ vm: props.vmName, tick: tick() }),
        async ({ vm }) => {
            const res = await fetch(`/api/graylog/logs?vm=${encodeURIComponent(vm)}&limit=30`);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`${res.status} - ${text.trim()}`);
            }
            // Get raw text response - NO JSON parsing
            return res.text();
        }
    );

    let timer: ReturnType<typeof setInterval> | undefined;
    createEffect(() => {
        if (timer !== undefined) { clearInterval(timer); timer = undefined; }
        if (autoRefresh()) timer = setInterval(() => setTick(t => t + 1), 10_000);
    });
    onCleanup(() => { if (timer !== undefined) clearInterval(timer); });

    return (
        <div class="space-y-3 p-3">
            {/* Toolbar */}
            <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-gray-300">
                    Raw Response for {props.vmName}
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
                        <p class="font-medium text-red-400">Error</p>
                        <p class="text-red-300 text-xs mt-0.5">{String(data.error)}</p>
                    </div>
                </div>
            </Show>

            {/* Raw text in scroll block */}
            <Show when={data.state === 'ready'}>
                <div class="bg-black border border-gray-700 rounded p-3 overflow-auto max-h-96">
                    <pre class="text-xs text-gray-300 whitespace-pre-wrap break-all">{data()}</pre>
                </div>
            </Show>
        </div>
    );
};
