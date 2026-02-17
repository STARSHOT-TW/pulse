import { Component } from 'solid-js';

interface LogsTabProps {
    vmName: string;
}

export const LogsTab: Component<LogsTabProps> = (props) => {
    return (
        <div class="space-y-4">
            {/* Header */}
            <div class="flex items-center gap-2">
                <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <h3 class="text-lg font-semibold text-gray-200">
                    Logs for {props.vmName}
                </h3>
            </div>

            {/* Placeholder content */}
            <div class="text-center py-12">
                <div class="text-gray-400 text-sm">
                    Logs tab placeholder
                </div>
                <div class="text-gray-500 text-xs mt-2">
                    Backend integration coming next
                </div>
            </div>
        </div>
    );
};
