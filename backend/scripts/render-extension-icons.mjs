import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const iconDirectory = path.join(repositoryRoot, 'extension/icons');
const source = await readFile(path.join(iconDirectory, 'youtube-buddy.svg'), 'utf8');
const sizes = [16, 32, 48, 128];

const browser = await chromium.launch({ headless: true });

try {
	const context = await browser.newContext({ deviceScaleFactor: 1 });
	const page = await context.newPage();

	for (const size of sizes) {
		await page.setViewportSize({ width: size, height: size });
		await page.setContent(`
			<!doctype html>
			<style>
				html, body, svg { display: block; width: 100%; height: 100%; margin: 0; }
			</style>
			${source}
		`);

		const image = await page.screenshot({ omitBackground: true });
		const width = image.readUInt32BE(16);
		const height = image.readUInt32BE(20);
		if (width !== size || height !== size) throw new Error(`Expected ${size}x${size}, rendered ${width}x${height}`);

		await writeFile(path.join(iconDirectory, `icon-${size}.png`), image);
	}

	await context.close();
} finally {
	await browser.close();
}
