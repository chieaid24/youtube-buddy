// Room Code generation and presentation helpers shared by the popup and tests.
// Content scripts do not load this file.
window.YTBRoomCode = (function () {
	'use strict';

	const DESCRIPTORS = Object.freeze([
		'silly',
		'happy',
		'snuggly',
		'wobbly',
		'sneaky',
		'goofy',
		'jolly',
		'fuzzy',
		'bouncy',
		'squishy',
		'dapper',
		'giggly',
		'cuddly',
		'cozy',
		'dreamy',
		'fluffy',
		'nimble',
		'zippy',
		'jazzy',
		'sparkly',
		'sunny',
		'gentle',
		'brave',
		'merry',
		'blue',
		'coral',
		'golden',
		'green',
		'indigo',
		'orange',
		'purple',
		'silver',
		'teal',
		'violet',
		'dancing',
		'floating',
		'hopping',
		'singing',
		'spinning',
		'splashing',
		'stargazing',
		'snoozing',
		'surfing',
		'twirling',
		'waving',
		'winking',
		'zooming',
	]);

	const ANIMALS = Object.freeze([
		'otters',
		'foxes',
		'pandas',
		'penguins',
		'llamas',
		'geese',
		'wolves',
		'mice',
		'bunnies',
		'kittens',
		'puppies',
		'ducks',
		'owls',
		'hedgehogs',
		'raccoons',
		'koalas',
		'sloths',
		'quokkas',
		'capybaras',
		'hamsters',
		'chinchillas',
		'ferrets',
		'squirrels',
		'chipmunks',
		'beavers',
		'badgers',
		'bats',
		'lambs',
		'ponies',
		'alpacas',
		'yaks',
		'moose',
		'deer',
		'giraffes',
		'elephants',
		'lions',
		'tigers',
		'bears',
		'wombats',
		'kangaroos',
		'platypuses',
		'lemurs',
		'meerkats',
		'seals',
		'dolphins',
		'whales',
		'narwhals',
		'turtles',
		'frogs',
		'geckos',
		'crabs',
		'octopuses',
		'seahorses',
		'starfish',
	]);

	function pick(list, random) {
		return list[Math.floor(random() * list.length)];
	}

	function generate(random = Math.random) {
		return `${pick(DESCRIPTORS, random)}-${pick(ANIMALS, random)}`;
	}

	class CheckFailedError extends Error {
		constructor() {
			super('Room Code availability check failed');
			this.name = 'CheckFailedError';
		}
	}

	async function generateAvailable({ random = Math.random, checkTaken }) {
		let candidate = '';
		for (let attempt = 0; attempt < 3; attempt++) {
			candidate = generate(random);
			let result;
			try {
				result = await checkTaken(candidate);
			} catch {
				throw new CheckFailedError();
			}
			if (result === 'free') return candidate;
			if (result !== 'taken') throw new CheckFailedError();
		}

		const suffix = Math.floor(random() * 900) + 100;
		return `${candidate}-${suffix}`;
	}

	function pretty(slug) {
		const words = String(slug)
			.split('-')
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1));
		return `The ${words.join(' ')}`;
	}

	const feedbackTimers = new WeakMap();

	/**
	 * Copy `text` to the clipboard, flashing the feedback line and — when a copy
	 * button is supplied — a checkmark on it. `button` is optional (the popup has
	 * one; the plain feedback flow does not); `writeText` overrides the Clipboard
	 * API in tests.
	 * @param {{ text: string, feedback: { textContent: string, classList: { toggle(name: string, force: boolean): void, remove(name: string): void } }, button?: { classList: { toggle(name: string, force: boolean): void, remove(name: string): void } }, writeText?: (text: string) => Promise<void>, durationMs?: number }} options
	 * @returns {Promise<boolean>}
	 */
	async function copy({ text, feedback, button, writeText, durationMs = 1500 }) {
		const previousTimer = feedbackTimers.get(feedback);
		if (previousTimer) clearTimeout(previousTimer);
		const copyText = writeText || navigator.clipboard.writeText.bind(navigator.clipboard);

		let succeeded = false;
		try {
			await copyText(text);
			succeeded = true;
		} catch {
			// The visible failure message is the complete error handling contract.
		}

		feedback.textContent = succeeded ? 'Copied!' : 'Could not copy';
		feedback.classList.toggle('is-error', !succeeded);
		if (button) button.classList.toggle('is-copied', succeeded);
		const timer = setTimeout(() => {
			feedback.textContent = '';
			feedback.classList.remove('is-error');
			if (button) button.classList.remove('is-copied');
			feedbackTimers.delete(feedback);
		}, durationMs);
		feedbackTimers.set(feedback, timer);
		return succeeded;
	}

	return Object.freeze({ DESCRIPTORS, ANIMALS, CheckFailedError, generate, generateAvailable, pretty, copy });
})();
