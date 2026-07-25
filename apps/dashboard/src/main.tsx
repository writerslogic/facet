// Dashboard React entrypoint: mounts <App/> into #root, wrapped in the React Query provider
// and the dashboard state provider.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AdminProvider } from './admin.js';
import './index.css';
import { DashboardProvider } from './state.js';
import { initTheme } from './theme.js';

// Apply the persisted palette + mode to <html> before first paint so there's no flash of the default theme.
initTheme();

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 60_000, refetchOnWindowFocus: false },
	},
});

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<DashboardProvider>
					<AdminProvider>
						<App />
					</AdminProvider>
				</DashboardProvider>
			</QueryClientProvider>
		</StrictMode>,
	);
}
