// Room Code generation and presentation helpers shared by the popup and tests.
// Content scripts do not load this file.
window.YTBRoomCode = (function () {
	'use strict';

	const DESCRIPTORS = Object.freeze([
		'silly',
		'chill',
		'happy',
		'snuggly',
		'wobbly',
		'sneaky',
		'goofy',
		'jolly',
		'fuzzy',
		'friendly',
		'bouncy',
		'squishy',
		'dapper',
		'giggly',
		'cuddly',
		'cozy',
		'fluffy',
		'nimble',
		'jazzy',
		'sparkly',
		'mysterious',
		'curious',
		'furious',
		'slimy',
		'conniving',
		'brave',
		'merry',
		'blue',
		'coral',
		'golden',
		'green',
		'orange',
		'silver',
		'platinum',
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
		'laughing',
		'chuckling',
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
		'platypi',
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
		'octopi',
		'seahorses',
		'starfish',
		'salmon',
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

	// Copies text to the clipboard, flashing feedback (and a checkmark on button, if given); writeText overrides the Clipboard API in tests.
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
