import { Component, createResource, createSignal, createEffect, onCleanup, Show, For } from 'solid-js';

interface LogEntry {
    time: string;    // formatted as [MM/DD HH:MM:SS]
    app: string;     // app name before first colon
    message: string; // everything after app name
}

interface LogsTabProps {
    vmName: string;
}

function parseCSV(csv: string, vmName: string): LogEntry[] {
    const lines = csv.trim().split('\n');
    if (lines.length === 0) return [];

    // Skip header line
    const dataLines = lines.slice(1);
    
    const entries: LogEntry[] = [];
    
    for (const line of dataLines) {
        // Parse CSV: "timestamp","message"
        const match = line.match(/^"([^"]+)","(.+)"$/);
        if (!match) continue;
        
        const timestamp = match[1];
        let message = match[2];
        
        // Format timestamp to [MM/DD HH:MM:SS]
        const date = new Date(timestamp);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const time = `[${month}/${day} ${hours}:${minutes}:${seconds}]`;
        
        // Remove hostname prefix
        const hostnamePrefix = `${vmName} `;
        if (message.startsWith(hostnamePrefix)) {
            message = message.slice(hostnamePrefix.length);
        }
        
        // Split app name from message (text before first colon)
        let app = '';
        let msg = message;
        const colonIndex = message.indexOf(':');
        if (colonIndex > 0) {
            app = message.slice(0, colonIndex);
            msg = message.slice(colonIndex); // keep the colon with message
        }
        
        entries.push({ time, app, message: msg });
    }
    
    return entries.reverse();
}

export const LogsTab: Component<LogsTabProps> = (props) => {
    const [tick, setTick] = createSignal(0);
    const [autoRefresh, setAutoRefresh] = createSignal(false);

    const [data] = createResource(
        () => ({ vm: props.vmName, tick: tick() }),
        async ({ vm }) => {
            const res = await fetch(`/api/graylog/logs?vm=${encodeURIComponent(vm)}`);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`${res.status} - ${text.trim()}`);
            }
            const csv = await res.text();
            return parseCSV(csv, vm);
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
            {/* Toolbar - only controls on the right */}
            <div class="flex items-center justify-end gap-2">
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
                    class="px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-white"
                >
                    {data.loading ? 'Loading...' : 'Refresh'}
                </button>
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

            {/* Empty state */}
            <Show when={data.state === 'ready' && data()?.length === 0}>
                <p class="text-center py-10 text-sm text-gray-500">No logs found</p>
            </Show>

            {/* Terminal-style log display */}
            <Show when={data.state === 'ready' && (data()?.length ?? 0) > 0}>
                <div class="bg-black border border-gray-700 rounded p-3 font-mono text-sm overflow-y-auto max-h-96" style="scrollbar-width: thin; scrollbar-color: #4B5563 #000000;">
                    <For each={data()}>
                        {(entry) => (
                            <div class="hover:bg-gray-900 px-1 py-0.5 whitespace-pre-wrap break-words">
                                <span class="text-green-400">{entry.time}</span>
                                <span class="text-blue-400 ml-1">{entry.app}</span>
                                <span class="text-white">{entry.message}</span>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
};
