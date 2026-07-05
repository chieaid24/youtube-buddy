import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './test/e2e',
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
});
