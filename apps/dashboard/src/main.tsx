// Dashboard React entrypoint: mounts <App/> into #root, wrapped in the React Query provider
// and the dashboard state provider.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';
import { DashboardProvider } from './state.js';

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
					<App />
				</DashboardProvider>
			</QueryClientProvider>
		</StrictMode>,
	);
}
