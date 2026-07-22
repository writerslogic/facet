// the read state model. A 401 surfaces the auth banner (not legitimate zeros); a non-401 error
// shows the error state; empty success shows the empty state; loading shows skeletons; and fixing the
// key recovers to real data.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { AdminProvider } from "../admin.js";
import { DashboardProvider } from "../state.js";

// uPlot needs a real canvas which jsdom lacks; mock it so the full-app render doesn't throw async.
vi.mock("uplot", () => ({
	default: class {
		constructor(_opts: unknown, _data: unknown, container: HTMLElement) {
			const node = document.createElement("div");
			node.className = "uplot";
			container.appendChild(node);
		}
		setSize() {}
		destroy() {}
	},
}));
vi.mock("uplot/dist/uPlot.min.css", () => ({}));

const VALID_SITE = "11111111-1111-4111-8111-111111111111";

function renderApp() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<DashboardProvider>
				<AdminProvider>
					<App />
				</AdminProvider>
			</DashboardProvider>
		</QueryClientProvider>,
	);
}

function seedProfile() {
	localStorage.setItem(
		"facet.profiles",
		JSON.stringify([
			{ id: "p1", label: "Prod", siteId: VALID_SITE, apiKey: "clk_x" },
		]),
	);
	localStorage.setItem("facet.activeProfile", "p1");
}

const emptyStats = {
	summary: { pageviews: 0, visitors: 0, events: 0 },
	series: [],
	top_paths: [],
	top_referrers: [],
	top_events: [],
	top_countries: [],
	top_devices: [],
	engagement: {
		sessions: 0,
		bounce_rate: 0,
		pages_per_session: 0,
		avg_duration_ms: 0,
	},
	channels: [],
};

const fullStats = {
	...emptyStats,
	summary: { pageviews: 42, visitors: 10, events: 3 },
	series: [{ t: 1000, pageviews: 42, visitors: 10 }],
};

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, "", "/");
	seedProfile();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("read state model", () => {
	it("shows the auth banner on 401 and does NOT render legitimate zeros", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				json: async () => ({ error: "invalid_api_key" }),
			}),
		);
		renderApp();
		await waitFor(() =>
			expect(
				screen.getByText("API key not recognized"),
			).toBeInTheDocument(),
		);
		// No KPI card zeros leaked through.
		expect(screen.queryByText("Pageviews")).not.toBeInTheDocument();
	});

	it("shows the error state on a non-401 failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				json: async () => ({ error: "range_too_large" }),
			}),
		);
		renderApp();
		await waitFor(() =>
			expect(
				screen.getByText("Could not load analytics"),
			).toBeInTheDocument(),
		);
		expect(
			screen.queryByText("API key not recognized"),
		).not.toBeInTheDocument();
	});

	it("shows the empty state on a successful zero", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue({ ok: true, json: async () => emptyStats }),
		);
		renderApp();
		await waitFor(() =>
			expect(screen.getAllByText("No data yet").length).toBeGreaterThan(
				0,
			),
		);
	});

	it("shows skeletons while loading", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		const { container } = renderApp();
		expect(container.querySelector(".shimmer")).not.toBeNull();
	});

	it("recovers to real data after the key is fixed via the switcher", async () => {
		// Bad key -> auth banner; then edit the profile's key through the header switcher -> real data.
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const auth =
					init?.headers && typeof init.headers === "object"
						? ((init.headers as Record<string, string>)
								.Authorization ?? "")
						: "";
				if (auth.includes("clk_good")) {
					return { ok: true, json: async () => fullStats };
				}
				return {
					ok: false,
					json: async () => ({ error: "invalid_api_key" }),
				};
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		renderApp();
		await waitFor(() =>
			expect(
				screen.getByText("API key not recognized"),
			).toBeInTheDocument(),
		);

		// Open the edit dialog and fix the API key.
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.change(screen.getByLabelText("API key"), {
			target: { value: "clk_good" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
		expect(screen.getAllByText("Pageviews").length).toBeGreaterThan(0);
	});
});
