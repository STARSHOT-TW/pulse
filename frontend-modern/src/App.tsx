import {
  Show,
  For,
  Suspense,
  lazy,
  createSignal,
  createContext,
  useContext,
  createEffect,
  createMemo,
  onCleanup,
  onMount,
  getOwner,
  runWithOwner,
} from 'solid-js';
import type { JSX } from 'solid-js';
import { Router, Route, Navigate, useNavigate, useLocation } from '@solidjs/router';
import { getGlobalWebSocketStore } from './stores/websocket-global';
import { ToastContainer } from './components/Toast/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SecurityWarning } from './components/SecurityWarning';
import { Login } from './components/Login';
import { logger } from './utils/logger';
import { POLLING_INTERVALS } from './constants';
import { STORAGE_KEYS } from '@/utils/localStorage';
import { layoutStore } from '@/utils/layout';
import { MONITORING_READ_SCOPE } from '@/constants/apiScopes';
import { UpdatesAPI } from './api/updates';
import type { VersionInfo } from './api/updates';
import { apiFetch } from './utils/apiClient';
import type { SecurityStatus } from '@/types/config';
import { SettingsAPI } from './api/settings';
import { eventBus } from './stores/events';
import { updateStore } from './stores/updates';
import { UpdateBanner } from './components/UpdateBanner';
import { DemoBanner } from './components/DemoBanner';
import { GitHubStarBanner } from './components/GitHubStarBanner';
import { createTooltipSystem } from './components/shared/Tooltip';
import type { State, Alert } from '@/types/api';
import { ProxmoxIcon } from '@/components/icons/ProxmoxIcon';
import { startMetricsSampler } from './stores/metricsSampler';
import { seedFromBackend } from './stores/metricsHistory';
import { getMetricsViewMode } from './stores/metricsViewMode';
import BoxesIcon from 'lucide-solid/icons/boxes';
import MonitorIcon from 'lucide-solid/icons/monitor';
import BellIcon from 'lucide-solid/icons/bell';
import SettingsIcon from 'lucide-solid/icons/settings';
import NetworkIcon from 'lucide-solid/icons/network';
import Maximize2Icon from 'lucide-solid/icons/maximize-2';
import Minimize2Icon from 'lucide-solid/icons/minimize-2';
import { PulsePatrolLogo } from '@/components/Brand/PulsePatrolLogo';
import { TokenRevealDialog } from './components/TokenRevealDialog';
import { useAlertsActivation } from './stores/alertsActivation';
import { UpdateProgressModal } from './components/UpdateProgressModal';
import type { UpdateStatus } from './api/updates';
import { AIChat } from './components/AI/Chat';
import { aiChatStore } from './stores/aiChat';
import { useResourcesAsLegacy } from './hooks/useResources';
import { updateSystemSettingsFromResponse, markSystemSettingsLoadedWithDefaults } from './stores/systemSettings';
import { initKioskMode, isKioskMode, setKioskMode, subscribeToKioskMode, getKioskModePreference } from './utils/url';


const Dashboard = lazy(() =>
  import('./components/Dashboard/Dashboard').then((module) => ({ default: module.Dashboard })),
);
const StorageComponent = lazy(() => import('./components/Storage/Storage'));
const Backups = lazy(() => import('./components/Backups/Backups'));
const Replication = lazy(() => import('./components/Replication/Replication'));
const MailGateway = lazy(() => import('./components/PMG/MailGateway'));
const CephPage = lazy(() => import('./pages/Ceph'));
const AlertsPage = lazy(() =>
  import('./pages/Alerts').then((module) => ({ default: module.Alerts })),
);
const SettingsPage = lazy(() => import('./components/Settings/Settings'));
const DockerHosts = lazy(() =>
  import('./components/Docker/DockerHosts').then((module) => ({ default: module.DockerHosts })),
);
const KubernetesClusters = lazy(() =>
  import('./components/Kubernetes/KubernetesClusters').then((module) => ({
    default: module.KubernetesClusters,
  })),
);
const HostsOverview = lazy(() =>
  import('./components/Hosts/HostsOverview').then((module) => ({
    default: module.HostsOverview,
  })),
);
const AIIntelligencePage = lazy(() =>
  import('./pages/AIIntelligence').then((module) => ({ default: module.AIIntelligence })),
);


// Enhanced store type with proper typing
type EnhancedStore = ReturnType<typeof getGlobalWebSocketStore>;

// Export WebSocket context for other components
export const WebSocketContext = createContext<EnhancedStore>();
export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within WebSocketContext.Provider');
  }
  return context;
};

// Dark mode context for reactive theme switching
export const DarkModeContext = createContext<() => boolean>(() => false);
export const useDarkMode = () => {
  const context = useContext(DarkModeContext);
  if (!context) {
    throw new Error('useDarkMode must be used within DarkModeContext.Provider');
  }
  return context;
};

// Docker route component - uses unified resources via useResourcesAsLegacy hook
function DockerRoute() {
  const wsContext = useContext(WebSocketContext);
  if (!wsContext) {
    return <div>Loading...</div>;
  }
  const { activeAlerts } = wsContext;
  const { asDockerHosts } = useResourcesAsLegacy();

  return <DockerHosts hosts={asDockerHosts() as any} activeAlerts={activeAlerts} />;
}

// Hosts route component - HostsOverview uses useResourcesAsLegacy directly for proper reactivity
function HostsRoute() {
  return <HostsOverview />;
}

function KubernetesRoute() {
  const wsContext = useContext(WebSocketContext);
  if (!wsContext) {
    return <div>Loading...</div>;
  }
  return <KubernetesClusters clusters={wsContext.state.kubernetesClusters ?? []} />;
}

// Helper to detect if an update is actively in progress (not just checking for updates)
function isUpdateInProgress(status: string | undefined): boolean {
  if (!status) return false;
  const inProgressStates = ['downloading', 'verifying', 'extracting', 'installing', 'restarting'];
  return inProgressStates.includes(status);
}

// Global update progress watcher - shows modal in ALL tabs when an update is running
function GlobalUpdateProgressWatcher() {
  const wsContext = useContext(WebSocketContext);
  const navigate = useNavigate();
  const [showProgressModal, setShowProgressModal] = createSignal(false);
  const [hasAutoOpened, setHasAutoOpened] = createSignal(false);
  let pollInterval: number | undefined;

  // Fallback polling in case WebSocket events are missed
  const pollUpdateStatus = async () => {
    try {
      const status = await UpdatesAPI.getUpdateStatus();
      const inProgress = isUpdateInProgress(status.status);

      if (inProgress && !showProgressModal() && !hasAutoOpened()) {
        logger.info('Update in progress detected via polling fallback, showing progress modal', {
          status: status.status,
          message: status.message,
        });
        setShowProgressModal(true);
        setHasAutoOpened(true);
      } else if (!inProgress && hasAutoOpened()) {
        setHasAutoOpened(false);
      }
    } catch (_error) {
      // Silently ignore polling errors
    }
  };

  // Watch for update progress events from WebSocket (primary mechanism)
  createEffect(() => {
    const progress = wsContext?.updateProgress?.() as UpdateStatus | null;

    if (!progress) {
      // Reset when no progress data
      setHasAutoOpened(false);
      return;
    }

    const inProgress = isUpdateInProgress(progress.status);

    if (inProgress && !showProgressModal() && !hasAutoOpened()) {
      // Update is starting - auto-open the modal in this tab
      logger.info('Update in progress detected via WebSocket, showing progress modal', {
        status: progress.status,
        message: progress.message,
      });
      setShowProgressModal(true);
      setHasAutoOpened(true);
    } else if (!inProgress && hasAutoOpened()) {
      // Update finished - allow the modal to be dismissed
      setHasAutoOpened(false);
    }
  });

  // Start fallback polling on mount, stop on cleanup
  onMount(() => {
    // Poll every 5 seconds as a safety net
    pollInterval = setInterval(pollUpdateStatus, 5000) as unknown as number;
  });

  onCleanup(() => {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
  });

  return (
    <UpdateProgressModal
      isOpen={showProgressModal()}
      onClose={() => setShowProgressModal(false)}
      onViewHistory={() => {
        setShowProgressModal(false);
        navigate('/settings/updates');
      }}
      connected={wsContext?.connected}
      reconnecting={wsContext?.reconnecting}
    />
  );
}

function App() {
  // Initialize kiosk mode from URL params immediately (persists to sessionStorage)
  // This must happen before any renders so kiosk state is available everywhere
  initKioskMode();

  // Reactive kiosk state for App-level components (banners, etc.)
  const [kioskMode, setKioskModeSignal] = createSignal(isKioskMode());
  onMount(() => {
    const unsubscribe = subscribeToKioskMode((enabled) => {
      setKioskModeSignal(enabled);
    });
    onCleanup(unsubscribe);
  });

  const TooltipRoot = createTooltipSystem();
  const owner = getOwner();
  const acquireWsStore = (): EnhancedStore => {
    const store = owner
      ? runWithOwner(owner, () => getGlobalWebSocketStore())
      : getGlobalWebSocketStore();
    return store || getGlobalWebSocketStore();
  };
  const alertsActivation = useAlertsActivation();

  // Start metrics sampler for sparklines
  onMount(() => {
    startMetricsSampler();

    // If user already has sparklines mode enabled, seed historical data immediately
    if (getMetricsViewMode() === 'sparklines') {
      seedFromBackend('1h').catch(() => {
        // Errors are already logged in seedFromBackend
      });
    }
  });

  let hasPreloadedRoutes = false;
  let hasFetchedVersionInfo = false;
  const preloadLazyRoutes = () => {
    if (hasPreloadedRoutes || typeof window === 'undefined') {
      return;
    }
    hasPreloadedRoutes = true;
    const loaders: Array<() => Promise<unknown>> = [
      () => import('./components/Storage/Storage'),
      () => import('./components/Backups/Backups'),
      () => import('./components/Replication/Replication'),
      () => import('./components/PMG/MailGateway'),
      () => import('./components/Hosts/HostsOverview'),

      () => import('./pages/Alerts'),
      () => import('./components/Settings/Settings'),
      () => import('./components/Docker/DockerHosts'),
    ];

    loaders.forEach((load) => {
      void load().catch((error) => {
        logger.warn('Preloading route module failed', error);
      });
    });
  };

  const fallbackState: State = {
    nodes: [],
    vms: [],
    containers: [],
    dockerHosts: [],
    removedDockerHosts: [],
    hosts: [],
    storage: [],
    cephClusters: [],
    physicalDisks: [],
    pbs: [],
    pmg: [],
    replicationJobs: [],
    metrics: [],
    pveBackups: {
      backupTasks: [],
      storageBackups: [],
      guestSnapshots: [],
    },
    pbsBackups: [],
    pmgBackups: [],
    backups: {
      pve: {
        backupTasks: [],
        storageBackups: [],
        guestSnapshots: [],
      },
      pbs: [],
      pmg: [],
    },
    performance: {
      apiCallDuration: {},
      lastPollDuration: 0,
      pollingStartTime: '',
      totalApiCalls: 0,
      failedApiCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
    },
    connectionHealth: {},
    stats: {
      startTime: new Date().toISOString(),
      uptime: 0,
      pollingCycles: 0,
      webSocketClients: 0,
      version: '0.0.0',
    },
    activeAlerts: [],
    recentlyResolved: [],
    lastUpdate: '',
  };

  // Simple auth state
  const [isLoading, setIsLoading] = createSignal(true);
  const [needsAuth, setNeedsAuth] = createSignal(false);
  const [hasAuth, setHasAuth] = createSignal(false);
  // Store full security status for Login component (hideLocalLogin, oidcEnabled, etc.)
  // Store full security status for Login component (hideLocalLogin, oidcEnabled, etc.)
  const [securityStatus, setSecurityStatus] = createSignal<SecurityStatus | null>(null);
  const [proxyAuthInfo, setProxyAuthInfo] = createSignal<{
    username?: string;
    logoutURL?: string;
  } | null>(null);

  // Don't initialize WebSocket until after auth check
  const [wsStore, setWsStore] = createSignal<EnhancedStore | null>(null);
  const state = (): State => wsStore()?.state || fallbackState;
  const connected = () => wsStore()?.connected() || false;
  const reconnecting = () => wsStore()?.reconnecting() || false;

  // Data update indicator
  const [dataUpdated, setDataUpdated] = createSignal(false);
  let updateTimeout: number;

  // Last update time formatting
  const [lastUpdateText, setLastUpdateText] = createSignal('');

  const formatLastUpdate = (timestamp: string) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  };

  // Flash indicator when data updates
  createEffect(() => {
    // Watch for state changes
    const updateTime = state().lastUpdate;
    if (updateTime && updateTime !== '') {
      setDataUpdated(true);
      setLastUpdateText(formatLastUpdate(updateTime));
      window.clearTimeout(updateTimeout);
      updateTimeout = window.setTimeout(() => setDataUpdated(false), POLLING_INTERVALS.DATA_FLASH);
    }
  });

  createEffect(() => {
    if (!isLoading() && !needsAuth()) {
      if (typeof window === 'undefined') {
        return;
      }
      if (!hasPreloadedRoutes) {
        // Defer to the next tick so we don't contend with initial render
        window.setTimeout(preloadLazyRoutes, 0);
      }
    }
  });

  createEffect(() => {
    if (isLoading() || needsAuth() || hasFetchedVersionInfo) {
      return;
    }
    hasFetchedVersionInfo = true;

    UpdatesAPI.getVersion()
      .then((version) => {
        setVersionInfo(version);
        // Check for updates after loading version info (non-blocking)
        updateStore.checkForUpdates();
      })
      .catch((error) => {
        logger.error('Failed to load version', error);
      });
  });

  let alertsInitialized = false;
  createEffect(() => {
    const ready = !isLoading() && !needsAuth();
    if (ready && !alertsInitialized) {
      alertsInitialized = true;
      void alertsActivation.refreshConfig();
      void alertsActivation.refreshActiveAlerts();
    }
    if (!ready) {
      alertsInitialized = false;
    }
  });

  // No longer need tab state management - using router now

  // Version info
  const [versionInfo, setVersionInfo] = createSignal<VersionInfo | null>(null);

  // Dark mode - initialize immediately from localStorage to prevent flash
  // This addresses issue #443 where dark mode wasn't persisting
  // Priority: 1. localStorage (user's last choice on this device)
  //           2. System preference
  //           3. Server preference (loaded later for cross-device sync)
  const savedDarkMode = localStorage.getItem(STORAGE_KEYS.DARK_MODE);
  const hasLocalPreference = savedDarkMode !== null;
  const initialDarkMode = hasLocalPreference
    ? savedDarkMode === 'true'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const [darkMode, setDarkMode] = createSignal(initialDarkMode);
  const [, setHasLoadedServerTheme] = createSignal(false);

  // Apply dark mode immediately on initialization
  if (initialDarkMode) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }

  // Toggle dark mode
  const toggleDarkMode = async () => {
    const newMode = !darkMode();
    setDarkMode(newMode);
    localStorage.setItem(STORAGE_KEYS.DARK_MODE, String(newMode));
    if (newMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    logger.info('Theme changed', { mode: newMode ? 'dark' : 'light' });

    // Save theme preference to server if authenticated
    if (!needsAuth()) {
      try {
        await SettingsAPI.updateSystemSettings({ theme: newMode ? 'dark' : 'light' });
        logger.info('Theme preference saved to server');
      } catch (error) {
        logger.error('Failed to save theme preference to server', error);
        // Don't show error to user - local change still works
      }
    }
  };

  // Don't initialize dark mode here - will be handled based on auth state

  // Listen for theme changes from other browser instances
  onMount(() => {
    const handleThemeChange = (theme?: string) => {
      if (!theme) return;
      logger.info('Received theme change from another browser instance', { theme });
      const isDark = theme === 'dark';

      // Update local state
      setDarkMode(isDark);
      localStorage.setItem(STORAGE_KEYS.DARK_MODE, String(isDark));

      // Update DOM
      if (isDark) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    };

    // Handle WebSocket reconnection - refresh alert config to restore activation state
    // This fixes issue where alert toggle appears disabled after connection loss
    const handleWebSocketReconnected = () => {
      logger.info('WebSocket reconnected, refreshing alert configuration');
      void alertsActivation.refreshConfig();
      void alertsActivation.refreshActiveAlerts();
    };

    // Subscribe to events
    eventBus.on('theme_changed', handleThemeChange);
    eventBus.on('websocket_reconnected', handleWebSocketReconnected);

    // Cleanup on unmount
    onCleanup(() => {
      eventBus.off('theme_changed', handleThemeChange);
      eventBus.off('websocket_reconnected', handleWebSocketReconnected);
    });
  });


  // Check auth on mount
  onMount(async () => {
    logger.debug('[App] Starting auth check...');

    // Check if we just logged out - if so, always show login page
    const justLoggedOut = localStorage.getItem('just_logged_out');

    // First check security status to see if auth is configured
    // We need this for ALL paths to properly set hideLocalLogin, oidcEnabled, etc.
    try {
      const securityRes = await apiFetch('/api/security/status');

      if (securityRes.status === 401) {
        logger.warn(
          '[App] Security status request returned 401. Clearing stored credentials and showing login.',
        );
        try {
          const { clearAuth } = await import('./utils/apiClient');
          clearAuth();
        } catch (clearError) {
          logger.warn('[App] Failed to clear stored auth after 401', clearError);
        }
        // Still try to parse security data from 401 response for OIDC settings
        // If not available, Login component will fetch it on mount
        setHasAuth(false);
        setNeedsAuth(true);
        setIsLoading(false);
        return;
      }

      // Handle just_logged_out AFTER we have security status
      if (justLoggedOut) {
        localStorage.removeItem('just_logged_out');
        logger.debug('[App] User logged out, showing login page');
        // Parse security data to get hideLocalLogin, oidcEnabled, etc.
        if (securityRes.ok) {
          const securityData = await securityRes.json();
          setSecurityStatus(securityData as SecurityStatus);
        }
        setHasAuth(true); // Force showing login instead of setup
        setNeedsAuth(true);
        setIsLoading(false);
        return;
      }

      if (!securityRes.ok) {
        throw new Error(`Security status request failed with status ${securityRes.status}`);
      }

      const securityData = await securityRes.json();
      logger.debug('[App] Security status fetched', securityData);

      // Store full security status for Login component
      setSecurityStatus(securityData as SecurityStatus);

      // Detect legacy DISABLE_AUTH flag (now ignored) so we can surface a warning
      if (securityData.deprecatedDisableAuth === true) {
        logger.warn(
          '[App] Legacy DISABLE_AUTH flag detected; authentication remains enabled. Remove the flag and restart Pulse to silence this warning.',
        );
      }

      const authConfigured = securityData.hasAuthentication || false;
      setHasAuth(authConfigured);

      // Check for proxy auth
      if (securityData.hasProxyAuth && securityData.proxyAuthUsername) {
        logger.info('[App] Proxy auth detected', { user: securityData.proxyAuthUsername });
        setProxyAuthInfo({
          username: securityData.proxyAuthUsername,
          logoutURL: securityData.proxyAuthLogoutURL,
        });
        setNeedsAuth(false);
        // Initialize WebSocket for proxy auth users
        setWsStore(acquireWsStore());

        // Load theme preference from server for cross-device sync
        // Only use server preference if no local preference exists
        if (!hasLocalPreference) {
          try {
            const systemSettings = await SettingsAPI.getSystemSettings();
            // Update system settings store (for Docker update actions, etc.)
            updateSystemSettingsFromResponse(systemSettings);
            if (systemSettings.theme && systemSettings.theme !== '') {
              const prefersDark = systemSettings.theme === 'dark';
              setDarkMode(prefersDark);
              localStorage.setItem(STORAGE_KEYS.DARK_MODE, String(prefersDark));
              if (prefersDark) {
                document.documentElement.classList.add('dark');
              } else {
                document.documentElement.classList.remove('dark');
              }
            }
            setHasLoadedServerTheme(true);
            // Also load full-width mode from server
            layoutStore.loadFromServer();
          } catch (error) {
            logger.error('Failed to load theme from server', error);
            // Ensure settings are marked as loaded so UI doesn't stay in loading state
            markSystemSettingsLoadedWithDefaults();
          }
        } else {
          setHasLoadedServerTheme(true);
          // Still load system settings for other features (Docker update actions, etc.)
          SettingsAPI.getSystemSettings()
            .then((settings) => updateSystemSettingsFromResponse(settings))
            .catch((error) => {
              logger.warn('Failed to load system settings', error);
              markSystemSettingsLoadedWithDefaults();
            });
        }

        // Load version info
        UpdatesAPI.getVersion()
          .then((version) => {
            setVersionInfo(version);
            // Check for updates after loading version info (non-blocking)
            updateStore.checkForUpdates();
          })
          .catch((error) => logger.error('Failed to load version', error));

        setIsLoading(false);
        return;
      }

      // Check for OIDC session
      if (securityData.oidcEnabled && securityData.oidcUsername) {
        logger.info('[App] OIDC session detected', { user: securityData.oidcUsername });
        setHasAuth(true); // OIDC is enabled, so auth is configured
        setProxyAuthInfo({
          username: securityData.oidcUsername,
          logoutURL: securityData.oidcLogoutURL, // OIDC logout URL from IdP
        });
        setNeedsAuth(false);
        // Initialize WebSocket for OIDC users
        setWsStore(acquireWsStore());

        // Load theme preference from server for cross-device sync
        // Only use server preference if no local preference exists
        if (!hasLocalPreference) {
          try {
            const systemSettings = await SettingsAPI.getSystemSettings();
            // Update system settings store (for Docker update actions, etc.)
            updateSystemSettingsFromResponse(systemSettings);
            if (systemSettings.theme && systemSettings.theme !== '') {
              const prefersDark = systemSettings.theme === 'dark';
              setDarkMode(prefersDark);
              localStorage.setItem(STORAGE_KEYS.DARK_MODE, String(prefersDark));
              if (prefersDark) {
                document.documentElement.classList.add('dark');
              } else {
                document.documentElement.classList.remove('dark');
              }
            }
            setHasLoadedServerTheme(true);
            // Also load full-width mode from server
            layoutStore.loadFromServer();
          } catch (error) {
            logger.error('Failed to load theme from server', error);
            // Ensure settings are marked as loaded so UI doesn't stay in loading state
            markSystemSettingsLoadedWithDefaults();
          }
        } else {
          setHasLoadedServerTheme(true);
          // Still load system settings for other features (Docker update actions, etc.)
          SettingsAPI.getSystemSettings()
            .then((settings) => updateSystemSettingsFromResponse(settings))
            .catch((error) => {
              logger.warn('Failed to load system settings', error);
              markSystemSettingsLoadedWithDefaults();
            });
        }

        // Load version info
        UpdatesAPI.getVersion()
          .then((version) => {
            setVersionInfo(version);
            // Check for updates after loading version info (non-blocking)
            updateStore.checkForUpdates();
          })
          .catch((error) => logger.error('Failed to load version', error));

        setIsLoading(false);
        return;
      }

      // If no auth is configured, show FirstRunSetup
      if (!authConfigured) {
        logger.info('[App] No auth configured, showing Login/FirstRunSetup');
        setNeedsAuth(true); // This will show the Login component which shows FirstRunSetup
        setIsLoading(false);
        return;
      }

      // If auth is configured, check if we're authenticated
      const stateRes = await apiFetch('/api/state', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
        },
      });

      if (stateRes.status === 401) {
        setNeedsAuth(true);
      } else {
        setNeedsAuth(false);
        // Only initialize WebSocket after successful auth check
        setWsStore(acquireWsStore());

        // Load theme preference from server for cross-device sync
        // Only use server preference if no local preference exists
        if (!hasLocalPreference) {
          try {
            const systemSettings = await SettingsAPI.getSystemSettings();
            // Update system settings store (for Docker update actions, etc.)
            updateSystemSettingsFromResponse(systemSettings);
            if (systemSettings.theme && systemSettings.theme !== '') {
              const prefersDark = systemSettings.theme === 'dark';
              setDarkMode(prefersDark);
              localStorage.setItem(STORAGE_KEYS.DARK_MODE, String(prefersDark));
              if (prefersDark) {
                document.documentElement.classList.add('dark');
              } else {
                document.documentElement.classList.remove('dark');
              }
            }
            setHasLoadedServerTheme(true);
            // Also load full-width mode from server
            layoutStore.loadFromServer();
          } catch (error) {
            logger.error('Failed to load theme from server', error);
            // Ensure settings are marked as loaded so UI doesn't stay in loading state
            markSystemSettingsLoadedWithDefaults();
          }
        } else {
          // We have a local preference, just mark that we've checked the server
          setHasLoadedServerTheme(true);
          // Still load system settings for other features (Docker update actions, etc.)
          SettingsAPI.getSystemSettings()
            .then((settings) => updateSystemSettingsFromResponse(settings))
            .catch((error) => {
              logger.warn('Failed to load system settings', error);
              // Ensure settings are marked as loaded so UI doesn't stay in loading state
              markSystemSettingsLoadedWithDefaults();
            });
        }
      }
    } catch (error) {
      logger.error('Auth check error', error);
      try {
        const { clearAuth } = await import('./utils/apiClient');
        clearAuth();
      } catch (clearError) {
        logger.warn('[App] Failed to clear stored auth after auth check error', clearError);
      }
      setHasAuth(false);
      setNeedsAuth(true);
    } finally {
      setIsLoading(false);
    }
  });

  const handleLogin = () => {
    window.location.reload();
  };

  const handleLogout = async () => {
    // Check if we're using proxy auth with a logout URL
    const proxyAuth = proxyAuthInfo();
    if (proxyAuth?.logoutURL) {
      // Redirect to proxy auth logout URL
      window.location.href = proxyAuth.logoutURL;
      return;
    }

    try {
      // Import the apiClient to get CSRF token support
      const { apiFetch, clearAuth } = await import('./utils/apiClient');

      // Clear any session data - this will include CSRF token
      const response = await apiFetch('/api/logout', {
        method: 'POST',
      });

      if (!response.ok) {
        logger.error('Logout failed', { status: response.status });
      }

      // Clear auth from apiClient
      clearAuth();
    } catch (error) {
      logger.error('Logout error', error);
    }

    // Clear only auth and session-specific storage, preserve user preferences
    // Keys to clear on logout (auth and per-session caches)
    const keysToRemove = [
      STORAGE_KEYS.AUTH,
      STORAGE_KEYS.LEGACY_TOKEN,
      STORAGE_KEYS.GUEST_METADATA,
      STORAGE_KEYS.DOCKER_METADATA,
      STORAGE_KEYS.DOCKER_METADATA + '_hosts',
    ];
    keysToRemove.forEach((key) => localStorage.removeItem(key));
    sessionStorage.clear();
    localStorage.setItem('just_logged_out', 'true');

    // Clear WebSocket connection
    if (wsStore()) {
      setWsStore(null);
    }

    // Force reload to login page
    window.location.href = '/';
  };

  // Pass through the store directly (only when initialized)
  const enhancedStore = () => wsStore();

  // Dashboard view - uses unified resources via useResourcesAsLegacy hook
  const DashboardView = () => {
    const { asVMs, asContainers, asNodes } = useResourcesAsLegacy();

    return (
      <Dashboard vms={asVMs() as any} containers={asContainers() as any} nodes={asNodes() as any} />
    );
  };

  const SettingsRoute = () => (
    <SettingsPage darkMode={darkMode} toggleDarkMode={toggleDarkMode} />
  );

  // Root layout component for Router
  const RootLayout = (props: { children?: JSX.Element }) => {
    // Check AI settings on mount and setup keyboard shortcut
    onMount(() => {
      // Only check AI settings if already authenticated (not on login screen)
      // Otherwise, the 401 response triggers a redirect loop
      if (!needsAuth()) {
        import('./api/ai').then(({ AIAPI }) => {
          AIAPI.getSettings()
            .then((settings) => {
              aiChatStore.setEnabled(settings.enabled && settings.configured);
              // Initialize chat session sync with server
              if (settings.enabled && settings.configured) {
                aiChatStore.initSync();
              }
            })
            .catch(() => {
              aiChatStore.setEnabled(false);
            });
        });
      }

      // Keyboard shortcut: Cmd/Ctrl+K to toggle AI
      const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          if (aiChatStore.enabled) {
            aiChatStore.toggle();
          }
        }
        // Escape to close
        if (e.key === 'Escape' && aiChatStore.isOpen) {
          aiChatStore.close();
        }
      };

      document.addEventListener('keydown', handleKeyDown);
      onCleanup(() => {
        document.removeEventListener('keydown', handleKeyDown);
      });
    });

    return (
      <Show
        when={!isLoading()}
        fallback={
          <div class="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
            <div class="text-gray-600 dark:text-gray-400">Loading...</div>
          </div>
        }
      >
        <Show when={!needsAuth()} fallback={<Login onLogin={handleLogin} hasAuth={hasAuth()} securityStatus={securityStatus() ?? undefined} />}>
          <ErrorBoundary>
            <Show when={enhancedStore()} fallback={
              <div class="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
                <div class="text-gray-600 dark:text-gray-400">Initializing...</div>
              </div>
            }>
              <WebSocketContext.Provider value={enhancedStore()!}>
                <DarkModeContext.Provider value={darkMode}>
                  <Show when={!kioskMode()}>
                    <SecurityWarning />
                    <DemoBanner />
                    <UpdateBanner />
                    <GitHubStarBanner />
                    <GlobalUpdateProgressWatcher />
                  </Show>
                  {/* Main layout container - flexbox to allow AI panel to push content */}
                  <div class="flex h-screen overflow-hidden">
                    {/* Main content area - shrinks when AI panel is open, scrolls independently */}
                    <div class={`flex-1 min-w-0 overflow-y-auto bg-gray-100 dark:bg-gray-900 text-gray-800 dark:text-gray-200 font-sans py-4 sm:py-6 transition-all duration-300`}>
                      <AppLayout
                        connected={connected}
                        reconnecting={reconnecting}
                        dataUpdated={dataUpdated}
                        lastUpdateText={lastUpdateText}
                        versionInfo={versionInfo}
                        hasAuth={hasAuth}
                        needsAuth={needsAuth}
                        proxyAuthInfo={proxyAuthInfo}
                        handleLogout={handleLogout}
                        state={state}
                        tokenScopes={() => securityStatus()?.tokenScopes}
                      >
                        {props.children}
                      </AppLayout>
                    </div>
                    {/* AI Panel - slides in from right, pushes content */}
                    <AIChat onClose={() => aiChatStore.close()} />
                  </div>
                  <TokenRevealDialog />
                  {/* AI Assistant Button moved to AppLayout to access kioskMode state */}
                  <TooltipRoot />
                </DarkModeContext.Provider>
              </WebSocketContext.Provider>
            </Show>
          </ErrorBoundary>
        </Show>
        <ToastContainer />
      </Show>
    );
  };

  // Use Router with routes
  return (
    <Router root={RootLayout}>
      <Route path="/" component={() => <Navigate href="/proxmox/overview" />} />
      <Route path="/proxmox" component={() => <Navigate href="/proxmox/overview" />} />
      <Route path="/proxmox/overview" component={DashboardView} />
      <Route path="/proxmox/storage" component={StorageComponent} />
      <Route path="/proxmox/ceph" component={CephPage} />
      <Route path="/proxmox/replication" component={Replication} />
      <Route path="/proxmox/mail" component={MailGateway} />
      <Route path="/proxmox/backups" component={Backups} />
      <Route path="/storage" component={() => <Navigate href="/proxmox/storage" />} />
      <Route path="/backups" component={() => <Navigate href="/proxmox/backups" />} />
      <Route path="/docker" component={DockerRoute} />
      <Route path="/kubernetes" component={KubernetesRoute} />
      <Route path="/hosts" component={HostsRoute} />

      <Route path="/servers" component={() => <Navigate href="/hosts" />} />
      <Route path="/alerts/*" component={AlertsPage} />
      <Route path="/ai/*" component={AIIntelligencePage} />
      <Route path="/settings/*" component={SettingsRoute} />
    </Router>
  );
}

function ConnectionStatusBadge(props: {
  connected: () => boolean;
  reconnecting: () => boolean;
  class?: string;
}) {
  return (
    <div
      class={`group status text-xs rounded-full flex items-center justify-center transition-all duration-500 ease-in-out px-1.5 ${props.connected()
        ? 'connected bg-green-200 dark:bg-green-700 text-green-700 dark:text-green-300 min-w-6 h-6 group-hover:px-3'
        : props.reconnecting()
          ? 'reconnecting bg-yellow-200 dark:bg-yellow-700 text-yellow-700 dark:text-yellow-300 py-1'
          : 'disconnected bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 min-w-6 h-6 group-hover:px-3'
        } ${props.class ?? ''}`}
    >
      <Show when={props.reconnecting()}>
        <svg class="animate-spin h-3 w-3 flex-shrink-0" fill="none" viewBox="0 0 24 24">
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
      </Show>
      <Show when={props.connected()}>
        <span class="h-2.5 w-2.5 rounded-full bg-green-600 dark:bg-green-400 flex-shrink-0"></span>
      </Show>
      <Show when={!props.connected() && !props.reconnecting()}>
        <span class="h-2.5 w-2.5 rounded-full bg-gray-600 dark:bg-gray-400 flex-shrink-0"></span>
      </Show>
      <span
        class={`whitespace-nowrap overflow-hidden transition-all duration-500 ${props.connected() || (!props.connected() && !props.reconnecting())
          ? 'max-w-0 group-hover:max-w-[100px] group-hover:ml-2 group-hover:mr-1 opacity-0 group-hover:opacity-100'
          : 'max-w-[100px] ml-1 opacity-100'
          }`}
      >
        {props.connected()
          ? 'Connected'
          : props.reconnecting()
            ? 'Reconnecting...'
            : 'Disconnected'}
      </span>
    </div>
  );
}

function AppLayout(props: {
  connected: () => boolean;
  reconnecting: () => boolean;
  dataUpdated: () => boolean;
  lastUpdateText: () => string;
  versionInfo: () => VersionInfo | null;
  hasAuth: () => boolean;
  needsAuth: () => boolean;
  proxyAuthInfo: () => { username?: string; logoutURL?: string } | null;
  handleLogout: () => void;
  state: () => State;
  tokenScopes: () => string[] | undefined;
  children?: JSX.Element;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const readSeenPlatforms = (): Record<string, boolean> => {
    if (typeof window === 'undefined') return {};
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.PLATFORMS_SEEN);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, boolean>;
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      }
    } catch (error) {
      logger.warn('Failed to parse stored platform visibility preferences', error);
    }
    return {};
  };

  const [seenPlatforms, setSeenPlatforms] = createSignal<Record<string, boolean>>(readSeenPlatforms());

  // Reactive kiosk mode state
  const [kioskMode, setKioskModeSignal] = createSignal(isKioskMode());

  // Subscribe to kiosk mode changes from other sources (like URL params)
  onMount(() => {
    const unsubscribe = subscribeToKioskMode((enabled) => {
      setKioskModeSignal(enabled);
    });
    onCleanup(unsubscribe);
  });

  // Auto-enable kiosk mode for monitoring-only tokens (if no user preference is set)
  createEffect(() => {
    const scopes = props.tokenScopes();
    // Only proceed if scopes are loaded and equal exactly ['monitoring:read']
    if (scopes && scopes.length === 1 && scopes[0] === MONITORING_READ_SCOPE) {
      // Check if user has an explicit preference
      const pref = getKioskModePreference();
      // If preference is unset (null), default to Kiosk Mode
      if (pref === null) {
        setKioskMode(true);
      }
    }
  });

  const toggleKioskMode = () => {
    const newValue = !kioskMode();
    setKioskMode(newValue);
    setKioskModeSignal(newValue);
  };

  const persistSeenPlatforms = (map: Record<string, boolean>) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEYS.PLATFORMS_SEEN, JSON.stringify(map));
    } catch (error) {
      logger.warn('Failed to persist platform visibility preferences', error);
    }
  };

  const markPlatformSeen = (platformId: string) => {
    setSeenPlatforms((current) => {
      if (current[platformId]) {
        return current;
      }
      const updated = { ...current, [platformId]: true };
      persistSeenPlatforms(updated);
      return updated;
    });
  };

  // Determine active tab from current path
  const getActiveTab = () => {
    const path = location.pathname;
    if (path.startsWith('/proxmox')) return 'proxmox';
    if (path.startsWith('/docker')) return 'docker';
    if (path.startsWith('/kubernetes')) return 'kubernetes';
    if (path.startsWith('/hosts')) return 'hosts';
    if (path.startsWith('/servers')) return 'hosts'; // Legacy redirect
    if (path.startsWith('/alerts')) return 'alerts';
    if (path.startsWith('/ai')) return 'ai';
    if (path.startsWith('/settings')) return 'settings';
    return 'proxmox';
  };
  const hasDockerHosts = createMemo(() => (props.state().dockerHosts?.length ?? 0) > 0);
  const hasKubernetesClusters = createMemo(() => (props.state().kubernetesClusters?.length ?? 0) > 0);
  const hasHosts = createMemo(() => (props.state().hosts?.length ?? 0) > 0);
  const hasProxmoxHosts = createMemo(
    () =>
      (props.state().nodes?.length ?? 0) > 0 ||
      (props.state().vms?.length ?? 0) > 0 ||
      (props.state().containers?.length ?? 0) > 0,
  );

  createEffect(() => {
    if (hasDockerHosts()) {
      markPlatformSeen('docker');
    }
  });

  createEffect(() => {
    if (hasKubernetesClusters()) {
      markPlatformSeen('kubernetes');
    }
  });

  createEffect(() => {
    if (hasProxmoxHosts()) {
      markPlatformSeen('proxmox');
    }
  });

  createEffect(() => {
    if (hasHosts()) {
      markPlatformSeen('hosts');
    }
  });

  const platformTabs = createMemo(() => {
    const allPlatforms = [
      {
        id: 'proxmox' as const,
        label: 'Proxmox',
        route: '/proxmox/overview',
        settingsRoute: '/settings',
        tooltip: 'Monitor Proxmox clusters and nodes',
        enabled: hasProxmoxHosts() || !!seenPlatforms()['proxmox'],
        live: hasProxmoxHosts(),
        icon: (
          <ProxmoxIcon class="w-4 h-4 shrink-0" />
        ),
        alwaysShow: true, // Proxmox is the default, always show
      },
      {
        id: 'docker' as const,
        label: 'Docker',
        route: '/docker',
        settingsRoute: '/settings/docker',
        tooltip: 'Monitor Docker hosts and containers',
        enabled: hasDockerHosts() || !!seenPlatforms()['docker'],
        live: hasDockerHosts(),
        icon: (
          <BoxesIcon class="w-4 h-4 shrink-0" />
        ),
        alwaysShow: true, // Docker is commonly used, keep visible
      },
      {
        id: 'kubernetes' as const,
        label: 'Kubernetes',
        route: '/kubernetes',
        settingsRoute: '/settings/agents',
        tooltip: 'Monitor Kubernetes clusters and workloads',
        enabled: hasKubernetesClusters(),
        live: hasKubernetesClusters(),
        icon: (
          <NetworkIcon class="w-4 h-4 shrink-0" />
        ),
        alwaysShow: false, // Only show when clusters exist
      },
      {
        id: 'hosts' as const,
        label: 'Hosts',
        route: '/hosts',
        settingsRoute: '/settings/host-agents',
        tooltip: 'Monitor hosts with the host agent',
        enabled: hasHosts() || !!seenPlatforms()['hosts'],
        live: hasHosts(),
        icon: (
          <MonitorIcon class="w-4 h-4 shrink-0" />
        ),
        alwaysShow: true, // Hosts is commonly used, keep visible
      },
    ];

    // Filter out platforms that should be hidden when not configured
    return allPlatforms.filter(p => p.alwaysShow || p.enabled);
  });

  const utilityTabs = createMemo(() => {
    const allAlerts = props.state().activeAlerts || [];
    const breakdown = allAlerts.reduce(
      (acc, alert: Alert) => {
        if (alert?.acknowledged) return acc;
        const level = String(alert?.level || '').toLowerCase();
        if (level === 'critical') {
          acc.critical += 1;
        } else {
          acc.warning += 1;
        }
        return acc;
      },
      { warning: 0, critical: 0 },
    );
    const activeAlertCount = breakdown.warning + breakdown.critical;

    // Check if settings should be shown based on token scopes
    // If no scopes (session auth), show settings
    // If scopes include '*' (wildcard) or 'settings:read', show settings
    const scopes = props.tokenScopes();
    const hasSettingsAccess = !scopes || scopes.length === 0 ||
      scopes.includes('*') || scopes.includes('settings:read');

    const tabs: Array<{
      id: 'alerts' | 'ai' | 'settings';
      label: string;
      route: string;
      tooltip: string;
      badge: 'update' | 'pro' | null;
      count: number | undefined;
      breakdown: { warning: number; critical: number } | undefined;
      icon: JSX.Element;
    }> = [
        {
          id: 'alerts',
          label: 'Alerts',
          route: '/alerts',
          tooltip: 'Review active alerts and automation rules',
          badge: null,
          count: activeAlertCount,
          breakdown,
          icon: <BellIcon class="w-4 h-4 shrink-0" />,
        },
        {
          id: 'ai',
          label: 'Patrol',
          route: '/ai',
          tooltip: 'Pulse Patrol monitoring and analysis',
          badge: null, // Patrol is free with BYOK; auto-fix is Pro
          count: undefined,
          breakdown: undefined,
          icon: <PulsePatrolLogo class="w-4 h-4 shrink-0" />,
        },
      ];

    // Only show settings tab if user has access
    if (hasSettingsAccess) {
      tabs.push({
        id: 'settings',
        label: 'Settings',
        route: '/settings',
        tooltip: 'Configure Pulse preferences and integrations',
        badge: updateStore.isUpdateVisible() ? 'update' : null,
        count: undefined,
        breakdown: undefined,
        icon: <SettingsIcon class="w-4 h-4 shrink-0" />,
      });
    }

    return tabs;
  });

  const handlePlatformClick = (platform: ReturnType<typeof platformTabs>[number]) => {
    if (platform.enabled) {
      navigate(platform.route);
    } else {
      navigate(platform.settingsRoute);
    }
  };

  const handleUtilityClick = (tab: ReturnType<typeof utilityTabs>[number]) => {
    navigate(tab.route);
  };

  return (
    <div class={`pulse-shell ${layoutStore.isFullWidth() || kioskMode() ? 'pulse-shell--full-width' : ''}`}>
      {/* Header - simplified in kiosk mode */}
      <div class={`header mb-3 flex items-center gap-2 ${kioskMode() ? 'justify-end' : 'justify-between sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-0'}`}>
        <Show when={!kioskMode()}>
          <div class="flex items-center gap-2 sm:flex-initial sm:gap-2 sm:col-start-2 sm:col-end-3 sm:justify-self-center">
  <div class="flex items-center gap-2">
    <svg
      viewBox="0 0 2281 517"
      xmlns="http://www.w3.org/2000/svg"
      width="285"
      height="65"
      class={`pulse-logo ${props.connected() && props.dataUpdated() ? 'animate-pulse-logo' : ''} text-blue-600 dark:text-blue-500`}
    >
      <title>Logo</title>

      <g fill="currentColor">
        <path d="M0 0 C24.09 0 48.18 0 73 0 C73 40.59 73 81.18 73 123 C111.94 123 150.88 123 191 123 C191 82.41 191 41.82 191 0 C215.09 0 239.18 0 264 0 C264 105.6 264 211.2 264 320 C239.91 320 215.82 320 191 320 C191 276.11 191 232.22 191 187 C152.06 187 113.12 187 73 187 C73 230.89 73 274.78 73 320 C48.91 320 24.82 320 0 320 C0 214.4 0 108.8 0 0 Z " fill="#0D3777" transform="translate(1361,78)"/>
<path d="M0 0 C2.79052765 0.00465197 5.58062145 -0.00239735 8.37109375 -0.02050781 C47.51946468 -0.27176815 90.14806251 2.50319507 120.17749023 30.80395508 C137.58528351 49.71140622 143.66374595 73.81471256 142.63793945 99.01586914 C141.23382052 120.84227239 130.48004703 140.65477796 114.48999023 155.31567383 C106.25490247 162.2229146 97.06805325 167.51073192 87.48999023 172.31567383 C88.02366211 172.57219727 88.55733398 172.8287207 89.10717773 173.09301758 C95.84473108 176.55504759 101.10417955 181.02224412 106.48999023 186.31567383 C107.04557617 186.85836914 107.60116211 187.40106445 108.17358398 187.96020508 C121.36538049 202.08150486 126.76357482 222.1862684 131.44308472 240.39642334 C132.4546211 244.33118008 133.48850478 248.25997015 134.52076721 252.18933105 C135.0531139 254.21663928 135.58439144 256.24422855 136.11460876 258.27209473 C138.59250939 267.74422537 141.1393049 277.19671352 143.72866821 286.63894653 C144.4056301 289.11085221 145.07717719 291.58418481 145.74853516 294.05761719 C146.17108578 295.59947006 146.59399986 297.14122339 147.01733398 298.68286133 C147.19403625 299.33753891 147.37073853 299.99221649 147.55279541 300.66673279 C149.58144811 307.99739254 152.07330542 315.06561938 154.48999023 322.31567383 C129.40999023 322.31567383 104.32999023 322.31567383 78.48999023 322.31567383 C73.63340396 308.96006156 69.04633853 296.10144856 65.48999023 282.44067383 C65.06777723 280.8561502 64.64474428 279.27184485 64.22094727 277.68774414 C62.16366611 269.9545895 60.19998179 262.20427824 58.35717773 254.41723633 C52.13951081 225.20389393 52.13951081 225.20389393 32.95483398 203.63598633 C18.78781605 196.04731428 0.52277239 197.85255891 -14.51000977 197.31567383 C-14.51000977 238.56567383 -14.51000977 279.81567383 -14.51000977 322.31567383 C-38.60000977 322.31567383 -62.69000977 322.31567383 -87.51000977 322.31567383 C-87.51000977 218.03567383 -87.51000977 113.75567383 -87.51000977 6.31567383 C-58.02260424 2.51084731 -29.5404669 -0.05279752 0 0 Z M-14.51000977 57.31567383 C-14.51000977 86.02567383 -14.51000977 114.73567383 -14.51000977 144.31567383 C24.19484696 145.99430455 24.19484696 145.99430455 57.48999023 129.31567383 C66.89927544 119.29030447 69.84179827 108.44388318 69.70092773 94.94848633 C69.0633148 83.96737476 64.83108327 74.07120631 56.73999023 66.50317383 C38.22324591 51.59859743 7.50700002 51.0250996 -14.51000977 57.31567383 Z " fill="#0D3777" transform="translate(911.510009765625,75.684326171875)"/>
<path d="M0 0 C31.68 0 63.36 0 96 0 C101.77010062 17.88731193 107.52921469 35.75965451 113.07235718 53.71557617 C114.78568986 59.2649203 116.50452635 64.81256022 118.22305107 70.36029816 C118.63545616 71.69171401 119.04779531 73.02315029 119.46006966 74.35460663 C124.5922967 90.92929309 129.75904846 107.49319764 134.92559052 124.05721283 C137.23610794 131.46505122 139.54593819 138.87310388 141.85546875 146.28125 C142.1113401 147.10198879 142.36721146 147.92272758 142.63083649 148.76833725 C146.35951298 160.7293099 150.08275234 172.6919634 153.80078125 184.65625 C154.03718952 185.41696241 154.27359779 186.17767483 154.51716995 186.96143913 C156.88011894 194.5652087 159.24224721 202.1692325 161.60282707 209.77373791 C166.68909054 226.15811145 171.79008184 242.53772373 176.91823959 258.90903854 C178.60641109 264.2997349 180.29250131 269.69108276 181.97872734 275.08238792 C183.60106641 280.26826247 185.22722191 285.45292083 186.85616207 290.63672543 C187.85835052 293.82901459 188.85705148 297.02238681 189.85479927 300.21606636 C190.3200528 301.70265321 190.78680755 303.18877114 191.2551403 304.67439079 C191.89462372 306.70352196 192.52888228 308.7342142 193.16186523 310.76538086 C193.51884995 311.9034166 193.87583466 313.04145233 194.24363708 314.213974 C195 317 195 317 195 320 C168.93 320 142.86 320 116 320 C105.12274096 284.95105422 105.12274096 284.95105422 99.91235352 267.61474609 C98.90962184 264.28235208 97.90103125 260.95176021 96.89257812 257.62109375 C96.24964357 255.48448222 95.60705102 253.34776774 94.96484375 251.2109375 C94.51503395 249.73009171 94.51503395 249.73009171 94.05613708 248.21932983 C93.649244 246.85851791 93.649244 246.85851791 93.23413086 245.47021484 C92.99480331 244.67610199 92.75547577 243.88198914 92.50889587 243.06381226 C92 241 92 241 92 238 C61.97 238 31.94 238 1 238 C-0.32 243.61 -1.64 249.22 -3 255 C-5.36402921 263.86236958 -5.36402921 263.86236958 -6.21240234 266.88952637 C-6.39744324 267.55133408 -6.58248413 268.21314178 -6.77313232 268.89500427 C-6.95627991 269.54969193 -7.13942749 270.20437958 -7.328125 270.87890625 C-7.67794434 272.13956909 -8.02776367 273.40023193 -8.38818359 274.69909668 C-9.67181168 279.32124467 -10.96122508 283.94178444 -12.25 288.5625 C-16.58125 304.1240625 -16.58125 304.1240625 -21 320 C-46.08 320 -71.16 320 -97 320 C-94.75032038 308.75160188 -94.75032038 308.75160188 -93.5456543 304.91088867 C-93.27236298 304.03034821 -92.99907166 303.14980774 -92.71749878 302.24258423 C-92.42271637 301.31046112 -92.12793396 300.37833801 -91.82421875 299.41796875 C-91.50736115 298.40076752 -91.19050354 297.38356628 -90.86404419 296.33554077 C-90.17380845 294.12091426 -89.48138517 291.90696861 -88.78701782 289.69363403 C-87.05843698 284.18154864 -85.34452495 278.6649115 -83.63038445 273.14832115 C-83.22330979 271.83845324 -82.81605696 270.52864069 -82.40863228 269.21888161 C-77.69728977 254.07271486 -73.07747379 238.89905769 -68.46825409 223.72155762 C-66.68992521 217.86644427 -64.90995091 212.01183065 -63.13022232 206.15714264 C-62.67833814 204.67057386 -62.22648222 203.18399649 -61.77465439 201.69741058 C-56.78174041 185.27050138 -51.76732002 168.85018606 -46.74834061 152.43122482 C-46.06334555 150.1902662 -45.37844304 147.94927931 -44.693573 145.70828247 C-40.24786402 131.16130263 -35.80045579 116.61484372 -31.3495369 102.06945705 C-28.92690638 94.1523578 -26.50502064 86.23503092 -24.08374786 78.31751633 C-23.61291336 76.77794676 -23.14204265 75.23838827 -22.67113495 73.69884109 C-16.4608742 53.39531946 -10.27600241 33.08482973 -4.23388672 12.73046875 C-3.90447334 11.6238942 -3.90447334 11.6238942 -3.56840515 10.4949646 C-2.99935592 8.58255868 -2.43255268 6.66948483 -1.8659668 4.75634766 C-1 2 -1 2 0 0 Z M45 57 C42.94233401 62.85551568 41.26806824 68.67766695 39.94140625 74.73828125 C39.55828051 76.44078655 39.17463021 78.14317387 38.79052734 79.84545898 C38.59110535 80.7349826 38.39168335 81.62450623 38.18621826 82.54098511 C32.17861971 109.23596883 25.00799452 135.58662517 17.4609375 161.8828125 C17.1727565 162.88735222 17.1727565 162.88735222 16.87875366 163.91218567 C16.00550331 166.95105991 15.12511787 169.98758534 14.23388672 173.02124023 C13.93498535 174.04677002 13.63608398 175.0722998 13.328125 176.12890625 C12.93995605 177.44483765 12.93995605 177.44483765 12.54394531 178.78735352 C11.88063658 181.10578904 11.88063658 181.10578904 12 184 C34.77 184 57.54 184 81 184 C76.96547718 169.59098991 72.91339872 155.20260902 68.70922852 140.84472656 C60.58273613 113.0350962 53.12596618 85.08136941 46 57 C45.67 57 45.34 57 45 57 Z " fill="#0D3777" transform="translate(587,78)"/>
<path d="M0 0 C0.81718506 0.28069336 1.63437012 0.56138672 2.47631836 0.85058594 C4.734375 1.69140625 4.734375 1.69140625 8.25 3.4375 C9.76466902 6.80391405 8.97431817 9.36222094 8.00244141 12.81689453 C7.70528229 13.89125763 7.40812317 14.96562073 7.10195923 16.07254028 C6.77182831 17.22680511 6.44169739 18.38106995 6.1015625 19.5703125 C5.76957855 20.75849579 5.4375946 21.94667908 5.09555054 23.17086792 C4.21195471 26.32527939 3.31970409 29.47707614 2.42352295 32.62792969 C1.5136646 35.83688375 0.6171901 39.04954946 -0.28125 42.26171875 C-1.5972381 46.94814286 -2.91327126 51.63453414 -4.24365234 56.31689453 C-4.51092133 57.25969269 -4.77819031 58.20249084 -5.05355835 59.17385864 C-5.75 61.4375 -5.75 61.4375 -6.75 63.4375 C-11.40999591 61.89686557 -16.06089419 60.33485485 -20.6953125 58.71875 C-46.29829453 49.86597761 -76.60465726 43.49500968 -102.55078125 54.640625 C-110.60936774 58.80840459 -115.87090604 64.80021812 -118.75 73.4375 C-119.46318195 81.92710818 -118.68938351 88.51832198 -113.53515625 95.390625 C-110.85123246 98.51788203 -107.86161051 100.6603115 -104.375 102.875 C-103.29476563 103.57496094 -102.21453125 104.27492188 -101.1015625 104.99609375 C-90.4996287 111.21757987 -78.9322167 115.67558498 -67.48580933 120.06356812 C-34.93331973 132.57731233 -1.82729106 147.30634453 14.25 180.4375 C24.70738435 204.00642716 24.93783523 230.2413008 16.05224609 254.42626953 C12.05292439 264.45256662 6.49416904 273.43296971 -0.75 281.4375 C-1.42546875 282.19417969 -2.1009375 282.95085937 -2.796875 283.73046875 C-24.00075684 306.21122668 -57.73663399 317.00787719 -87.98139954 318.55137634 C-90.27697582 318.61672953 -92.57078949 318.65365611 -94.8671875 318.67578125 C-95.71376923 318.6855751 -96.56035095 318.69536896 -97.43258667 318.70545959 C-130.21681465 319.00633024 -169.13380143 317.77566884 -197.75 299.4375 C-197.13115291 292.12841415 -195.62520668 285.28213484 -193.80859375 278.18359375 C-193.3778933 276.47140404 -193.3778933 276.47140404 -192.93849182 274.72462463 C-192.02704542 271.10665491 -191.10740642 267.49082687 -190.1875 263.875 C-189.56521144 261.41094456 -188.94346099 258.94675314 -188.32226562 256.48242188 C-186.80440017 250.46586064 -185.27981682 244.45103282 -183.75 238.4375 C-180.24838846 239.57849918 -176.813305 240.77155756 -173.421875 242.20703125 C-144.71273031 254.1594218 -106.37299856 265.27920898 -75.85888672 253.72119141 C-66.20410461 249.73244171 -59.82074903 245.28095511 -55.375 235.75 C-52.3310574 227.32160433 -52.68157833 218.86666196 -56.4453125 210.7421875 C-66.25843886 193.40762298 -89.44028382 186.61369702 -107 180.0625 C-128.27726778 172.11650728 -147.2574603 163.10968457 -164.75 148.4375 C-165.3378125 147.99535156 -165.925625 147.55320313 -166.53125 147.09765625 C-175.57226257 140.08234225 -182.35487596 130.1015855 -187.25 119.875 C-187.56380615 119.22813232 -187.8776123 118.58126465 -188.20092773 117.91479492 C-196.84627991 98.73048185 -196.88213916 73.25091286 -189.61865234 53.59912109 C-179.33439416 28.00698452 -159.93684204 10.22391663 -134.75 -0.75 C-124.71073289 -4.93682037 -114.42303235 -7.5594319 -103.75 -9.5625 C-103.05293945 -9.69382324 -102.35587891 -9.82514648 -101.63769531 -9.96044922 C-68.30707843 -15.83989747 -31.73117654 -11.16572819 0 0 Z " fill="#0D3777" transform="translate(1290.75,84.5625)"/>
<path d="M0 0 C0.81718506 0.28069336 1.63437012 0.56138672 2.47631836 0.85058594 C4.734375 1.69140625 4.734375 1.69140625 8.25 3.4375 C9.76466902 6.80391405 8.97431817 9.36222094 8.00244141 12.81689453 C7.70528229 13.89125763 7.40812317 14.96562073 7.10195923 16.07254028 C6.77182831 17.22680511 6.44169739 18.38106995 6.1015625 19.5703125 C5.76957855 20.75849579 5.4375946 21.94667908 5.09555054 23.17086792 C4.21195471 26.32527939 3.31970409 29.47707614 2.42352295 32.62792969 C1.5136646 35.83688375 0.6171901 39.04954946 -0.28125 42.26171875 C-1.5972381 46.94814286 -2.91327126 51.63453414 -4.24365234 56.31689453 C-4.51092133 57.25969269 -4.77819031 58.20249084 -5.05355835 59.17385864 C-5.75 61.4375 -5.75 61.4375 -6.75 63.4375 C-11.40999591 61.89686557 -16.06089419 60.33485485 -20.6953125 58.71875 C-46.29829453 49.86597761 -76.60465726 43.49500968 -102.55078125 54.640625 C-110.60936774 58.80840459 -115.87090604 64.80021812 -118.75 73.4375 C-119.46318195 81.92710818 -118.68938351 88.51832198 -113.53515625 95.390625 C-110.85123246 98.51788203 -107.86161051 100.6603115 -104.375 102.875 C-103.29476562 103.57496094 -102.21453125 104.27492188 -101.1015625 104.99609375 C-90.4996287 111.21757987 -78.9322167 115.67558498 -67.48580933 120.06356812 C-34.93331973 132.57731233 -1.82729106 147.30634453 14.25 180.4375 C24.70738435 204.00642716 24.93783523 230.2413008 16.05224609 254.42626953 C12.05292439 264.45256662 6.49416904 273.43296971 -0.75 281.4375 C-1.42546875 282.19417969 -2.1009375 282.95085937 -2.796875 283.73046875 C-24.00075684 306.21122668 -57.73663399 317.00787719 -87.98139954 318.55137634 C-90.27697582 318.61672953 -92.57078949 318.65365611 -94.8671875 318.67578125 C-95.71376923 318.6855751 -96.56035095 318.69536896 -97.43258667 318.70545959 C-130.21681465 319.00633024 -169.13380143 317.77566884 -197.75 299.4375 C-197.13115291 292.12841415 -195.62520668 285.28213484 -193.80859375 278.18359375 C-193.3778933 276.47140404 -193.3778933 276.47140404 -192.93849182 274.72462463 C-192.02704542 271.10665491 -191.10740642 267.49082687 -190.1875 263.875 C-189.56521144 261.41094456 -188.94346099 258.94675314 -188.32226562 256.48242188 C-186.80440017 250.46586064 -185.27981682 244.45103282 -183.75 238.4375 C-180.24838846 239.57849918 -176.813305 240.77155756 -173.421875 242.20703125 C-144.71273031 254.1594218 -106.37299856 265.27920898 -75.85888672 253.72119141 C-66.20410461 249.73244171 -59.82074903 245.28095511 -55.375 235.75 C-52.3310574 227.32160433 -52.68157833 218.86666196 -56.4453125 210.7421875 C-66.25843886 193.40762298 -89.44028382 186.61369702 -107 180.0625 C-128.27726778 172.11650728 -147.2574603 163.10968457 -164.75 148.4375 C-165.3378125 147.99535156 -165.925625 147.55320313 -166.53125 147.09765625 C-175.57226257 140.08234225 -182.35487596 130.1015855 -187.25 119.875 C-187.56380615 119.22813232 -187.8776123 118.58126465 -188.20092773 117.91479492 C-196.84627991 98.73048185 -196.88213916 73.25091286 -189.61865234 53.59912109 C-179.33439416 28.00698452 -159.93684204 10.22391663 -134.75 -0.75 C-124.71073289 -4.93682037 -114.42303235 -7.5594319 -103.75 -9.5625 C-103.05293945 -9.69382324 -102.35587891 -9.82514648 -101.63769531 -9.96044922 C-68.30707843 -15.83989747 -31.73117654 -11.16572819 0 0 Z " fill="#0D3777" transform="translate(216.75,84.5625)"/>
<path d="M0 0 C81.51 0 163.02 0 247 0 C247 20.46 247 40.92 247 62 C218.29 62 189.58 62 160 62 C160 147.14 160 232.28 160 320 C135.91 320 111.82 320 87 320 C87 234.86 87 149.72 87 62 C58.29 62 29.58 62 0 62 C0 41.54 0 21.08 0 0 Z " fill="#0D3777" transform="translate(2027,78)"/>
<path d="M0 0 C81.51 0 163.02 0 247 0 C247 20.46 247 40.92 247 62 C218.29 62 189.58 62 160 62 C160 147.14 160 232.28 160 320 C135.91 320 111.82 320 87 320 C87 234.86 87 149.72 87 62 C58.29 62 29.58 62 0 62 C0 41.54 0 21.08 0 0 Z " fill="#0D3777" transform="translate(262,78)"/>
<path d="M0 0 C0.7621582 0.39541992 1.52431641 0.79083984 2.30957031 1.19824219 C7.40574296 3.93469966 12.48836991 6.92642805 16.75 10.875 C16.75 11.535 16.75 12.195 16.75 12.875 C10.4713722 12.25275471 4.36556431 11.31115282 -1.81640625 10.0625 C-2.69473618 9.88871826 -3.5730661 9.71493652 -4.47801208 9.53588867 C-7.25689165 8.98579708 -10.03477372 8.43088362 -12.8125 7.875 C-15.59385923 7.31945278 -18.37542881 6.76507624 -21.15769958 6.21411133 C-22.88013952 5.87294681 -24.60207032 5.52919751 -26.32337952 5.18237305 C-48.43063307 0.79938882 -78.46423088 -1.0344341 -98.78515625 10.19921875 C-104.05672434 13.78321671 -107.21951971 17.837947 -109.25 23.875 C-111.24875919 38.5867973 -103.43051059 53.20667317 -94.87451172 64.72705078 C-92.26256207 68.01935587 -89.5127513 71.17547668 -86.68432617 74.28442383 C-85.05823078 76.08765982 -83.47405948 77.92429761 -81.88671875 79.76171875 C-71.73856337 91.36787907 -60.68180428 101.77251082 -48.25 110.875 C-47.57243652 111.37563965 -46.89487305 111.8762793 -46.19677734 112.39208984 C-40.92395963 116.28065843 -35.6016754 120.09584429 -30.25 123.875 C-29.09491943 124.69170166 -29.09491943 124.69170166 -27.91650391 125.52490234 C-16.88549961 133.28882819 -5.60885939 140.48820827 6.04199219 147.28417969 C8.82588618 148.91957937 11.58884979 150.58691627 14.3515625 152.2578125 C29.92505032 161.56472845 45.99773908 169.53227586 62.40307617 177.26171875 C63.2788028 177.67867004 64.15452942 178.09562134 65.05679321 178.52520752 C66.71691024 179.31523811 68.38107324 180.09683711 70.0496521 180.86883545 C71.9881069 181.79455008 73.87533311 182.82610598 75.75 183.875 C76.08 184.865 76.41 185.855 76.75 186.875 C72.46006113 186.29983042 68.89681245 185.26701673 64.9375 183.53125 C63.80022461 183.03608887 62.66294922 182.54092773 61.49121094 182.03076172 C60.24402434 181.47910396 58.9969581 180.92717405 57.75 180.375 C56.42237814 179.79272636 55.09457367 179.21086893 53.76660156 178.62939453 C49.42243237 176.72317755 45.08564658 174.80050793 40.75 172.875 C40.0170874 172.5497937 39.2841748 172.2245874 38.52905273 171.88952637 C21.23287117 164.21255577 3.98086188 156.43862677 -13.25317383 148.62329102 C-30.45706 140.82189462 -47.69642974 133.11916107 -65.02000427 125.58746338 C-73.70990541 121.80818594 -82.38591618 117.99722685 -91.0625 114.1875 C-91.92094513 113.81068085 -92.77939026 113.43386169 -93.66384888 113.04562378 C-107.03490257 107.17573636 -120.39490181 101.2810871 -133.75 95.375 C-147.28032943 89.39149298 -160.81557192 83.41942261 -174.36157227 77.47146606 C-176.95960593 76.33024366 -179.55699291 75.18755973 -182.15429688 74.04467773 C-189.38301066 70.86665631 -196.61622643 67.70504778 -203.890625 64.6328125 C-205.53659668 63.93393921 -205.53659668 63.93393921 -207.21582031 63.22094727 C-209.16427276 62.39675878 -211.11648059 61.58136179 -213.07324219 60.77709961 C-213.89469727 60.4291333 -214.71615234 60.08116699 -215.5625 59.72265625 C-216.60857422 59.2896521 -216.60857422 59.2896521 -217.67578125 58.84790039 C-219.25 57.875 -219.25 57.875 -220.25 54.875 C-218.91985222 52.58385096 -217.57222345 50.55383356 -216 48.4375 C-215.54906982 47.81858887 -215.09813965 47.19967773 -214.63354492 46.56201172 C-210.67728909 41.23662313 -206.33213838 36.3544272 -201.76953125 31.546875 C-199.68163771 29.33273673 -197.70344433 27.08107915 -195.75 24.75 C-172.01311128 -2.40993886 -135.20678824 -19.32667035 -99.44335938 -21.99609375 C-64.4499849 -24.05269457 -31.02889261 -16.1048352 0 0 Z " fill="#0D3777" transform="translate(1920.25,93.125)"/>
<path d="M0 0 C8.17905366 3.10905488 16.11023052 6.7332325 24.05154419 10.39501953 C27.95386371 12.19429923 31.85965326 13.98600922 35.765625 15.77734375 C36.55252213 16.13835175 37.33941925 16.49935974 38.15016174 16.87130737 C45.26552728 20.13106044 52.41142496 23.31934562 59.5625 26.5 C81.85911793 36.4460023 103.88300893 46.97957776 125.8527832 57.62451172 C132.66536361 60.91334364 139.52640734 64.04307415 146.46264648 67.06030273 C152.09748556 69.53711987 157.57787095 72.27096444 163.0625 75.0625 C172.20711134 79.7017095 181.47146517 84.0256092 190.8125 88.25 C191.50993317 88.56549805 192.20736633 88.88099609 192.92593384 89.20605469 C197.23069198 91.1519034 201.53792946 93.09221696 205.8460083 95.03070068 C212.15047087 97.86771777 218.45228885 100.71052564 224.75 103.5625 C225.42975891 103.87013275 226.10951782 104.1777655 226.80987549 104.49472046 C238.00794454 109.56914216 249.10398921 114.8356756 260.13769531 120.25805664 C267.99284359 124.10281699 275.93476861 127.62348598 284 131 C284 131.99 284 132.98 284 134 C277.81963057 132.02478432 271.81846125 129.76527216 265.8203125 127.296875 C254.96538819 122.90048762 243.96442111 119.00947631 232.875 115.25 C231.87119293 114.90883148 230.86738586 114.56766296 229.8331604 114.21615601 C200.48900186 104.27510199 170.71349313 94.63093687 140 90 C139.21077148 89.87979492 138.42154297 89.75958984 137.60839844 89.63574219 C133.08197489 88.96713322 128.55520173 88.44016556 124 88 C122.95585938 87.88914062 121.91171875 87.77828125 120.8359375 87.6640625 C98.07545784 85.61506555 65.71016919 83.16745182 46.8125 98.875 C41.71151063 103.97598937 39.88262605 108.51092853 39.5 115.6875 C39.9001009 129.6562402 49.11790821 142.55502528 57.4375 153.25 C57.86756348 153.80413574 58.29762695 154.35827148 58.74072266 154.92919922 C65.04612739 162.81854779 72.24351195 169.23639714 80.375 175.1875 C81.23552979 175.82534424 82.09605957 176.46318848 82.98266602 177.12036133 C89.67251181 182.06540235 96.40851581 186.94862902 103.17529297 191.7878418 C111.22995157 197.55520188 111.22995157 197.55520188 114 200 C114 200.66 114 201.32 114 202 C99.62832349 200.3761872 86.27702186 193.39380438 73.36346436 187.22659302 C71.93655666 186.54519867 70.50777671 185.86770827 69.07696533 185.19454956 C53.66983794 177.91663218 40.72615219 168.3004007 28 157 C27.34644531 156.41992188 26.69289063 155.83984375 26.01953125 155.2421875 C2.5815123 133.08463039 -11.07545473 100.97312861 -12.2890625 68.99609375 C-12.77802898 46.03795317 -10.59023404 20.78823718 0 0 Z " fill="#0D3777" transform="translate(1686,188)"/>
<path d="M0 0 C6.02577532 0.25559201 10.95112428 2.43644378 16.375 4.9375 C17.68404297 5.53594727 17.68404297 5.53594727 19.01953125 6.14648438 C47.99469619 19.66682622 72.94150357 40.39647617 92 66 C92.63679688 66.85335937 93.27359375 67.70671875 93.9296875 68.5859375 C117.42213147 101.17223075 130.47594187 139.86397402 130.26074219 180.06079102 C130.25002457 182.43206424 130.26070858 184.80257765 130.2734375 187.17382812 C130.30301439 214.36943052 130.30301439 214.36943052 125 222 C121.125 221.125 121.125 221.125 120 220 C119.79362988 213.51868845 120.29830052 207.2491061 121 200.8125 C125.84238262 152.38867382 111.4251082 104.06519417 80.91015625 66.08203125 C78.3484104 62.98498878 75.68635164 59.98922462 73 57 C71.77056637 55.54189172 70.54136612 54.08358659 69.3125 52.625 C65.83434423 48.69883822 62.04287276 45.33393299 58 42 C57.47905762 41.56139648 56.95811523 41.12279297 56.42138672 40.67089844 C41.78082976 28.37102058 25.75915347 18.79783733 8.13671875 11.34375 C6.95722656 10.8384375 5.77773437 10.333125 4.5625 9.8125 C3.51191406 9.38582031 2.46132812 8.95914063 1.37890625 8.51953125 C-1 7 -1 7 -1.97265625 4.44921875 C-1.98167969 3.64097656 -1.99070312 2.83273438 -2 2 C-1.34 1.34 -0.68 0.68 0 0 Z " fill="#0D3777" transform="translate(1896,50)"/>
<path d="M0 0 C2.1875 0.5 2.1875 0.5 3.1875 1.5 C3.02419896 8.01571154 0.65781315 11.06858787 -3.5625 15.625 C-4.43660522 16.59614746 -4.43660522 16.59614746 -5.32836914 17.58691406 C-7.13669159 19.5773085 -8.96915645 21.5420367 -10.8125 23.5 C-11.36083496 24.0868457 -11.90916992 24.67369141 -12.47412109 25.27832031 C-24.46357405 38.00316541 -38.07436013 48.17170908 -52.8125 57.5 C-53.86179687 58.17675781 -54.91109375 58.85351562 -55.9921875 59.55078125 C-94.52470653 83.05655997 -147.74231312 91.47764809 -191.8125 81.5 C-192.71291016 81.30132324 -193.61332031 81.10264648 -194.54101562 80.89794922 C-208.49412433 77.74076276 -221.75672518 73.34780694 -234.8125 67.5 C-235.57320801 67.17290039 -236.33391602 66.84580078 -237.11767578 66.50878906 C-237.84325684 66.1784668 -238.56883789 65.84814453 -239.31640625 65.5078125 C-239.96552979 65.21793457 -240.61465332 64.92805664 -241.28344727 64.62939453 C-242.8125 63.5 -242.8125 63.5 -243.65600586 61.56201172 C-243.8125 59.5 -243.8125 59.5 -241.8125 56.5 C-236.52135714 57.02300128 -232.30829931 58.40105732 -227.5 60.6875 C-183.46129535 80.63899277 -132.15960785 81.37473633 -86.95605469 64.42919922 C-64.83108497 55.73908873 -45.53306333 43.70596014 -28.078125 27.57421875 C-26.01734629 25.68754031 -23.9005845 23.90727574 -21.75 22.125 C-16.09762919 17.2148597 -11.61395234 11.1697758 -7.0859375 5.23828125 C-3.42353462 0.60862838 -3.42353462 0.60862838 0 0 Z " fill="#0D3777" transform="translate(1983.8125,340.5)"/>
<path d="M0 0 C4.73894351 0.68961804 8.80701246 2.4763621 13.1640625 4.3671875 C13.97187668 4.71344177 14.77969086 5.05969604 15.61198425 5.41644287 C18.28519811 6.56423559 20.95515273 7.7194002 23.625 8.875 C25.50993255 9.68686549 27.39494367 10.4985486 29.2800293 11.31005859 C44.29216833 17.78385526 59.24828664 24.38306499 74.19287109 31.01098633 C86.01984776 36.25444464 97.87156561 41.43669967 109.75 46.5625 C110.52317566 46.89636719 111.29635132 47.23023438 112.09295654 47.57421875 C120.00747756 50.99155301 127.92461541 54.40258211 135.85229492 57.78930664 C145.17821178 61.82682275 154.43688658 65.99684221 163.6484375 70.2890625 C164.28883783 70.58740746 164.92923817 70.88575241 165.58904457 71.19313812 C180.7345937 78.26251444 195.68661781 85.7085034 210.62042236 93.21240234 C213.39947037 94.60738318 216.18079127 95.99779918 218.96211338 97.38823891 C232.4889656 104.15195302 245.99118353 110.95076084 259.34033203 118.06103516 C263.84945368 120.46212095 268.4098188 122.75800918 273 125 C273 125.66 273 126.32 273 127 C267.7659636 126.39575626 263.52008888 124.70177604 258.7578125 122.58984375 C257.94202225 122.23488327 257.12623199 121.87992279 256.28572083 121.51420593 C253.56277389 120.32806935 250.8439559 119.13275352 248.125 117.9375 C244.15095716 116.20163138 240.17500171 114.47015988 236.19921875 112.73828125 C235.14902054 112.27999939 234.09882233 111.82171753 233.01679993 111.34954834 C224.8902042 107.80799038 216.74076932 104.32225658 208.58203125 100.85546875 C207.35247823 100.33226371 206.12296575 99.80896341 204.89349365 99.28556824 C197.6804818 96.21491945 197.6804818 96.21491945 190.46270752 93.15548706 C175.50251412 86.82588573 160.78213715 80.1388187 146.19213867 73.00268555 C139.96575087 69.9622834 133.67948302 67.06174716 127.375 64.1875 C113.76426793 57.94657657 100.30826255 51.40149018 86.84947205 44.84155273 C81.88749921 42.42544077 76.90971759 40.04403277 71.92529297 37.67456055 C54.04821992 29.16900106 36.38264162 20.23367265 18.68994141 11.35302734 C12.46357411 8.22812111 6.23222815 5.11319849 0 2 C0 1.34 0 0.68 0 0 Z " fill="#0D3777" transform="translate(1740,181)"/>
<path d="M0 0 C4.01442358 0.56145528 7.45733209 1.42471713 11.18359375 3.01171875 C12.67294434 3.64243286 12.67294434 3.64243286 14.19238281 4.28588867 C15.26327148 4.74842041 16.33416016 5.21095215 17.4375 5.6875 C18.57928711 6.17516846 19.72107422 6.66283691 20.89746094 7.1652832 C30.21318748 11.169334 39.44479522 15.35415403 48.66928101 19.56326294 C59.77776724 24.62531601 70.98708311 29.41766433 82.25 34.125 C96.41563312 40.04982627 110.51125114 46.08974402 124.50244141 52.41894531 C126.94058234 53.5210953 129.38002042 54.61980189 131.82177734 55.71386719 C164.40113399 70.31912006 196.44034993 86.06934681 228.30395508 102.17016602 C236.46101376 106.28147062 244.70613262 110.17476783 253 114 C253 114.99 253 115.98 253 117 C246.40609824 114.94296653 240.12343781 112.42343666 233.8125 109.625 C231.77490243 108.73009786 229.73713312 107.83558671 227.69921875 106.94140625 C226.61817871 106.46590332 225.53713867 105.99040039 224.42333984 105.50048828 C220.85562666 103.93671954 217.28258222 102.3855773 213.70703125 100.83984375 C213.08793381 100.57218704 212.46883636 100.30453033 211.83097839 100.02876282 C210.56675148 99.48229489 209.30250474 98.93587285 208.03823853 98.38949585 C197.01712639 93.62562879 186.02000441 88.8104134 175.04248047 83.94677734 C169.12971024 81.33917658 163.18673494 78.82963819 157.2019043 76.39233398 C142.14663339 70.24745251 127.58074532 63.18035639 113 56 C105.58552779 52.34969004 98.16938114 48.70282347 90.75 45.0625 C89.78140045 44.58703735 88.8128009 44.11157471 87.81484985 43.6217041 C74.15712336 36.92460136 60.42346486 30.45031196 46.54467773 24.22583008 C37.22932394 20.04403253 28.00039513 15.70487869 18.8125 11.25 C18.19890625 10.95254883 17.5853125 10.65509766 16.953125 10.34863281 C11.28564423 7.59805655 5.63160533 4.82335593 0 2 C0 1.34 0 0.68 0 0 Z " fill="#0D3777" transform="translate(1652,159)"/>

      </g>
    </svg>
    <Show when={props.versionInfo()?.channel === 'rc'}>
      <span class="text-xs px-1.5 py-0.5 bg-orange-500 text-white rounded font-bold">
        RC
      </span>
    </Show>
  </div>
</div>
        </Show>
        <div class={`header-controls flex items-center gap-2 ${kioskMode() ? '' : 'justify-end sm:col-start-3 sm:col-end-4 sm:w-auto sm:justify-end sm:justify-self-end'}`}>
          <Show when={props.hasAuth() && !props.needsAuth()}>
            <div class="flex items-center gap-2">
              {/* Kiosk Mode Toggle */}
              <button
                type="button"
                onClick={toggleKioskMode}
                class={`group relative flex h-7 w-7 items-center justify-center rounded-full text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${kioskMode()
                  ? 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }`}
                title={kioskMode() ? 'Exit kiosk mode (show navigation)' : 'Enter kiosk mode (hide navigation)'}
                aria-label={kioskMode() ? 'Exit kiosk mode' : 'Enter kiosk mode'}
                aria-pressed={kioskMode()}
              >
                <Show when={kioskMode()} fallback={<Maximize2Icon class="h-3 w-3 flex-shrink-0" />}>
                  <Minimize2Icon class="h-3 w-3 flex-shrink-0" />
                </Show>
              </button>
              <Show when={props.proxyAuthInfo()?.username}>
                <span class="text-xs px-2 py-1 text-gray-600 dark:text-gray-400">
                  {props.proxyAuthInfo()?.username}
                </span>
              </Show>
              <button
                type="button"
                onClick={props.handleLogout}
                class="group relative flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 text-xs text-gray-700 transition hover:bg-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                title="Logout"
                aria-label="Logout"
              >
                <svg
                  class="h-3 w-3 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
              </button>
            </div>
          </Show>
          <ConnectionStatusBadge
            connected={props.connected}
            reconnecting={props.reconnecting}
            class="flex-shrink-0"
          />
        </div>
      </div>

      {/* Tabs - hidden in kiosk mode */}
      <Show when={!kioskMode()}>
        <div
          class="tabs mb-2 flex items-end gap-2 overflow-x-auto overflow-y-hidden whitespace-nowrap border-b border-gray-300 dark:border-gray-700 scrollbar-hide"
          role="tablist"
          aria-label="Primary navigation"
        >
          <div class="flex items-end gap-1" role="group" aria-label="Infrastructure">
            <For each={platformTabs()}>
              {(platform) => {
                const isActive = () => getActiveTab() === platform.id;
                const disabled = () => !platform.enabled;
                const baseClasses =
                  'tab relative px-1.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium flex items-center gap-1 sm:gap-1.5 rounded-t border border-transparent transition-colors whitespace-nowrap cursor-pointer';

                const className = () => {
                  if (isActive()) {
                    return `${baseClasses} bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 border-gray-300 dark:border-gray-700 border-b border-b-white dark:border-b-gray-800 shadow-sm font-semibold`;
                  }
                  if (disabled()) {
                    return `${baseClasses} cursor-not-allowed text-gray-400 dark:text-gray-600 opacity-70 bg-gray-100/40 dark:bg-gray-800/40`;
                  }
                  return `${baseClasses} text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/60`;
                };

                const title = () =>
                  disabled()
                    ? `${platform.label} is not configured yet. Click to open settings.`
                    : platform.tooltip;

                return (
                  <div
                    class={className()}
                    role="tab"
                    aria-disabled={disabled()}
                    onClick={() => handlePlatformClick(platform)}
                    title={title()}
                  >
                    {platform.icon}
                    <span class="hidden xs:inline">{platform.label}</span>
                    <span class="xs:hidden">{platform.label.charAt(0)}</span>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="flex items-end gap-1 ml-auto" role="group" aria-label="System">
            <div class="flex items-end gap-1 pl-1 sm:pl-4">
              <For each={utilityTabs()}>
                {(tab) => {
                  const isActive = () => getActiveTab() === tab.id;
                  const baseClasses =
                    'tab relative px-1.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium flex items-center gap-1 sm:gap-1.5 rounded-t border border-transparent transition-colors whitespace-nowrap cursor-pointer';

                  const className = () => {
                    if (isActive()) {
                      return `${baseClasses} bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 border-gray-300 dark:border-gray-700 border-b border-b-white dark:border-b-gray-800 shadow-sm font-semibold`;
                    }
                    return `${baseClasses} text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/60`;
                  };

                  return (
                    <div
                      class={className()}
                      role="tab"
                      aria-disabled={false}
                      onClick={() => handleUtilityClick(tab)}
                      title={tab.tooltip}
                    >
                      {tab.icon}
                      <span class="flex items-center gap-1">
                        <span class="hidden xs:inline">{tab.label}</span>
                        <span class="xs:hidden">{tab.label.charAt(0)}</span>
                        {tab.id === 'alerts' && (() => {
                          const total = tab.count ?? 0;
                          if (total <= 0) {
                            return null;
                          }
                          return (
                            <span class="inline-flex items-center gap-1">
                              {tab.breakdown && tab.breakdown.critical > 0 && (
                                <span class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white bg-red-600 dark:bg-red-500 rounded-full">
                                  {tab.breakdown.critical}
                                </span>
                              )}
                              {tab.breakdown && tab.breakdown.warning > 0 && (
                                <span class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold text-amber-900 dark:text-amber-100 bg-amber-200 dark:bg-amber-500/80 rounded-full">
                                  {tab.breakdown.warning}
                                </span>
                              )}
                            </span>
                          );
                        })()}
                      </span>
                      <Show when={tab.badge === 'update'}>
                        <span class="ml-1 flex items-center">
                          <span class="sr-only">Update available</span>
                          <span aria-hidden="true" class="block h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
                        </span>
                      </Show>
                      <Show when={tab.badge === 'pro'}>
                        <span class="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/50 rounded">
                          Pro
                        </span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      </Show>

      {/* Main Content */}
      <main
        id="main"
        class="tab-content block bg-white dark:bg-gray-800 rounded-b rounded-tr rounded-tl shadow mb-2"
      >
        <div class="pulse-panel">
          <Suspense fallback={<div class="p-6 text-sm text-gray-500 dark:text-gray-400">Loading view...</div>}>
            {props.children}
          </Suspense>
        </div>
      </main>

      {/* Footer - hidden in kiosk mode */}
      <Show when={!kioskMode()}>
        <footer class="text-center text-xs text-gray-500 dark:text-gray-400 py-4">
          STARSHOT
          <Show when={props.lastUpdateText()}>
            <span class="mx-2">|</span>
            <span>Last refresh: {props.lastUpdateText()}</span>
          </Show>
        </footer>
      </Show>

      {/* Fixed AI Assistant Button - only shows when chat is CLOSED and NOT in kiosk mode */}
      <Show when={aiChatStore.enabled === true && !aiChatStore.isOpenSignal() && !kioskMode()}>
        <button
          type="button"
          onClick={() => aiChatStore.toggle()}
          class="fixed right-0 top-1/2 -translate-y-1/2 z-40 flex items-center gap-1.5 pl-2 pr-1.5 py-3 rounded-l-xl bg-blue-600 text-white shadow-lg hover:bg-blue-700 transition-colors duration-200 group sm:top-1/2 sm:translate-y-[-50%] top-auto bottom-20 translate-y-0"
          title={aiChatStore.context.context?.name ? `Pulse Assistant - ${aiChatStore.context.context.name}` : 'Pulse Assistant (⌘K)'}
          aria-label="Expand Pulse Assistant"
        >
          <svg
            class="h-5 w-5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            stroke-width="1.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
            />
          </svg>
        </button>
      </Show>
    </div>
  );
}

export default App; // Test hot-reload comment $(date)
