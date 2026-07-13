// Root dashboard component. Renders the site picker + metrics views once the API layer lands
// (T021–T023). For now it renders a minimal shell so the build/typecheck are green.

import type { ReactElement } from 'react';

export function App(): ReactElement {
	return (
		<main>
			<h1>Countless</h1>
			<p>Dashboard coming online.</p>
		</main>
	);
}
